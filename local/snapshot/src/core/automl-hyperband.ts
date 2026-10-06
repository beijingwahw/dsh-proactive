/**
 * 93.0 自动机调优内核 —— Hyperband 多预算自适应超参寻优：bracket 闭式调度 / SH 复用单元 / 学习曲线工厂 / 全预算随机对照
 *
 * 动机: 73.0 最佳臂识别回答「17 个候选引擎谁是冠军」——臂是离散的、每臂一次性
 * 全量评估。但元认知引擎的自调优面对更一般的问题: 配置空间连续且巨大（阈值 ×
 * 窗口 × 学习率的组合爆炸）、单次全预算评估贵（全量 benchmark 沙盒），而
 * **好配置在低预算下已经露头**（性能曲线随预算凸饱和、收益递减）——劣质配置
 * 提前处决、预算集中给幸存者，才是样本经济的姿态。Hyperband（Li et al. 2017）
 * 的洞见: 不赌任何单一「配置数 vs 单配置预算」折衷，用 s_max+1 个 bracket 把
 * 整条探索-开发谱系一次铺开，对性能曲线形状零先验。
 *
 * 数学:
 *   SH 复用单元（successiveHalvingUnit）: n 个配置从预算 r₀ 起跑，第 i 轮只留
 *   ⌊n·r₀/r_i⌋ 个（r_i = r₀·η^i ⇒ ≈1/η 减员）、每配置预算 ×η——「配置数 ÷η
 *   × 预算 ×η」的几何交换使每轮成本 c_i = n_i·r_i 近似不变（不等式:
 *   |c_{i+1} − c_i| < r_{i+1}，⌊·⌋ 取整松弛小于 1 个配置的下一轮预算）;
 *   平手按候选下标升序——确定性。
 *   bracket 闭式调度（bracketSchedule）: s_max = ⌊log_η R⌋; bracket s 配
 *   n_s = ⌈(B/R)·η^s/(s+1)⌉ 个配置、初始预算 r_s = R·η^(−s)，其中
 *   B = (s_max+1)·R 为归一预算。每轮成本 ≈ n_s·r_s = B/(s+1)，s+1 轮合计
 *   ≈ B——所有 bracket 同价（交换不变性的直接推论），总预算 = (s_max+1)·B，
 *   取整松弛每 bracket ⊂ (−ηR/(η−1), (s+1)·r_s]。η=3、R=81（论文口径）:
 *   n = [81,34,15,8,5]、r = [1,3,9,27,81]、Σ = 405+363+351+378+405 = 1902
 *   ≈ 0.94 × 名义 2025。s 大 → 多配置低预算（探索端，SH 激进淘汰）; s 小 →
 *   少配置全预算（开发端，保真到 R）。
 *   学习曲线工厂: score(b) = q∞·(1−e^(−kb))——凸饱和（收益递减）、配置相关的
 *   最终质量 q∞ 与爬升速度 k; k 带宽越窄，低预算排序对全预算排序的部分保持
 *   （Spearman ρ）越强——「部分排序成立性可控」。晚熟型反例（大 q∞ × 小 k）
 *   诚实揭示边界: SH 的早停假设排序一致性，晚熟者会被低预算轮提前处决
 *   （锚点⑤量化差距——不吹牛）。
 *
 * 验证锚点（scripts/verify-automl-hyperband.mjs）:
 *   ① 同总预算质量: 5000 曲线池、40 种子——Hyperband（总预算 1902，实际检视
 *      143 个配置）选出配置的最终质量 ≥ 池 95 分位的命中率 ≥ 0.9，且对同预算
 *      全预算随机对照（23 个配置）胜率 ≥ 0.7（样本经济差）;
 *   ② 预算效率: 100 配置快饱和曲线（k∈[2.5,3.5]），达到「全预算搜索最好成绩
 *      − 0.02」的中位预算比 ≤ 随机搜索的 1/3;
 *   ③ 调度数学: bracketSchedule(81,3) 复现论文调度表 n=[81,34,15,8,5]、
 *      r=[1,3,9,27,81]; η 几何逐 bracket r_{i+1} = η·r_i（1e-9）; 成本交换
 *      不变 |c_{i+1}−c_i| ≤ r_{i+1}; 预算守恒 Σ bracket = totalBudget（独立
 *      重加和 1e-9）; η=2、R=27 分数预算第二实例同检;
 *   ④ SH 单元: 窄带曲线（k∈[2,2.4]）ρ(score@1, 最终质量) > 0.8 且 > 宽带
 *      对照（带宽 ⇒ 部分排序保持度可控）; SH 冠军 = 真实 argmax、真值冠军存活
 *      低预算轮; 每轮成本表 [81,81,81,81,81];
 *   ⑤ 晚熟型反例: q∞=1.0、k=0.1 的配置预算 1 排名 100/100、预算 27 排名
 *      1/100（排序翻转即欺骗机制）; 20 种子 Hyperband 仅少数（理论 ≈ 12%，
 *      bracket 0/1 捡漏）找到它，中位差距 ≥ 0.05——量化并文档化边界。
 *
 * 应用: 元认知引擎调参自动化——17 引擎的超参（阈值、窗口、学习率）从手工配置
 *   升级为 Hyperband 自动寻优: evaluate(config, budget) = benchmark 沙盒按预算
 *   缩放的质量分。与 73.0 BAI 的分工: BAI 选离散臂、每臂一次性全量评估（引擎
 *   选型）; 本内核管连续配置空间 × 可提前终止的全预算曲线（超参寻优）——两层
 *   正交。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── 第五轮世界性进化（R5-A15，四轴）──
 * 1. [数学] Hyperband 的最优 η 理论（etaSweep）：连续松弛下总预算
 *    = R·(s_max+1)²（s_max = ⌊log_η R⌋），取整松弛有界；η 扫描给出
 *    「探索-开发谱系」的解析账本——configsExamined（Σn_s，检视广度）
 *    随 η 增大总体收缩（非严格——s_max 台阶处局部次序可反转，如
 *    R=81 时 η=5 的 36 < η=6 的 48）、高保真档槽数（slotsByBudget）
 *    随 η 收缩（小 η = 更多全预算 bracket = 晚熟型配置更多露头机会）
 *    ——η 的选择是「广度 vs 保真」的显式权衡，不再拍脑袋取 3。
 * 2. [数学] 异步 bracket（AsyncHyperband，资源感知调度）：把 hyperband
 *    的同步主循环拆成可中断的任务流——round 屏障（bracket 内下一轮
 *    幸存者依赖本轮全部成绩）+ worker 上限 + 探索端优先的确定性签发
 *    序。完成时 budgetIssued === schedule.totalBudget（守恒）；workers
 *    充裕 + FIFO 回报时逐 bracket 复现 hyperband() 的幸存者/冠军
 *    （同步语义的异步化不改变数学——等价锚）。
 * 3. [数值] survivorCount 整数精确整除路径：n·r₀ 与整除全在整数域
 *    （安全整数范围内 (p − p%ri)/ri 精确），浮点路径加 1e-9 残差
 *    护栏——减员数不再踩 n·r₀/ri 的浮点尘埃。
 * 4. [性质] 预算守恒批量断言（≥200 种子化 (R,η) 实例）：Σ bracket
 *    预算 = totalBudget 独立重加和、r 几何、|c_{i+1}−c_i| ≤ r_{i+1}、
 *    减员数与 BigInt 精确有理数 floor(n/η^i) 逐轮一致。
 */

// ─────────────────────────── 类型定义 ───────────────────────────

/** 配置来源: 有限列表（按有放回均匀 i.i.d. 抽样——与论文 get_hyperparameter_configuration 一致）或采样器 (rng) => T */
export type ConfigSource<T> = ReadonlyArray<T> | ((rng: () => number) => T);

/** 调度表单轮: 第 round 轮评估 numConfigs 个配置、每个 perConfigBudget 预算，成本 cost = numConfigs × perConfigBudget */
export interface HyperbandScheduleRound {
  round: number;
  numConfigs: number;
  perConfigBudget: number;
  cost: number;
}

/** 调度表单 bracket: s 值、初始配置数 n_s、初始预算 r_s、逐轮计划与 bracket 总预算 */
export interface HyperbandScheduleBracket {
  s: number;
  nConfigs: number;
  initialBudget: number;
  rounds: HyperbandScheduleRound[];
  budget: number;
}

/** Hyperband 闭式调度表（bracketSchedule 的输出） */
export interface HyperbandSchedule {
  eta: number;
  maxBudget: number;
  /** s_max = ⌊log_η R⌋ */
  sMax: number;
  /** 归一预算 B = (s_max+1)·R（论文口径，每个 bracket 的名义预算） */
  normalizerBudget: number;
  /** 实际总预算 = Σ bracket 预算（执行口径，取整松弛诚实入账） */
  totalBudget: number;
  /** 从 s_max 到 0 降序（探索端先行） */
  brackets: HyperbandScheduleBracket[];
}

/** SH 单元单轮记录: 评估的 configs/scores（对齐）+ 幸存者（分数降序、平手下标升序） */
export interface ShRound<T> {
  round: number;
  perConfigBudget: number;
  numConfigs: number;
  cost: number;
  configs: T[];
  scores: number[];
  survivors: T[];
}

/** 全程最佳观察（含预算口径） */
export interface ShBestObserved<T> {
  config: T;
  score: number;
  budget: number;
}

/** SH 复用单元结果 */
export interface ShResult<T> {
  rounds: ShRound<T>[];
  /** 末轮冠军（末轮裁到 1: SH 语义的胜者） */
  winner: T;
  winnerScore: number;
  /** 历代观察最大（含中间轮） */
  bestObserved: ShBestObserved<T>;
  totalCost: number;
  eliminated: number;
}

/** hyperband 主循环入参 */
export interface HyperbandOptions<T> {
  /** 评估函数: 同一 (config, budget) 必须返回相同分数（确定性）; 分数需随 budget 单调不减 */
  evaluate: (config: T, budget: number) => number;
  configs: ConfigSource<T>;
  /** 淘汰率 η > 1，缺省 3 */
  eta?: number;
  /** 单配置最大预算 R ≥ 1 */
  maxBudget: number;
  /** RNG 种子（缺省 1; 同种子同输出——纯函数） */
  seed?: number;
}

/** 单次评估轨迹条目（预算审计与「达到目标的预算」分析用） */
export interface HyperbandEvaluation<T> {
  bracket: number;
  round: number;
  config: T;
  budget: number;
  score: number;
  cumulativeBudget: number;
}

/** 单 bracket 执行记录（轮次与幸存者） */
export interface HyperbandBracketResult<T> {
  s: number;
  nConfigs: number;
  initialBudget: number;
  rounds: ShRound<T>[];
  budget: number;
  winner: T;
  winnerScore: number;
}

/** hyperband 主循环结果 */
export interface HyperbandResult<T> {
  /** 历代观察分数最大的配置（论文口径 "largest L seen so far"; 平手取最早） */
  bestConfig: T;
  bestScore: number;
  /** 逐配置预算加和（=== schedule.totalBudget，1e-9 内） */
  totalBudgetSpent: number;
  brackets: HyperbandBracketResult<T>[];
  /** 全部评估按执行序（末条 cumulativeBudget = totalBudgetSpent） */
  evaluations: HyperbandEvaluation<T>[];
  schedule: HyperbandSchedule;
}

/** 学习曲线（凸饱和: score(b) = q∞·(1−e^(−kb))） */
export interface LearningCurve {
  id: number;
  /** 最终质量 q∞ ∈ (0,1] */
  finalQuality: number;
  /** 爬升速度 k > 0（越小越「晚熟」） */
  rate: number;
  /** 是否工厂注入的晚熟型反例 */
  lateBloomer: boolean;
  score: (budget: number) => number;
}

/** 学习曲线工厂入参 */
export interface LearningCurveFactoryOptions {
  /** 曲线条数（正整数） */
  n: number;
  seed?: number;
  /** q∞ 均匀采样区间 [lo, hi] ⊆ (0,1]，缺省 [0.5, 0.95] */
  quality?: [number, number];
  /** k 均匀采样区间 [lo, hi] ⊆ (0,∞)，缺省 [2.0, 3.0]; 带宽越窄部分排序保持越强 */
  rate?: [number, number];
  /** 注入 1 条晚熟型反例（末位 id = n−1）; true 用缺省 (q∞, k) = (1.0, 0.1) */
  deception?: boolean | { finalQuality?: number; rate?: number };
}

/** 全预算随机搜索入参（对照基线） */
export interface RandomSearchOptions<T> {
  evaluate: (config: T, budget: number) => number;
  configs: ConfigSource<T>;
  /** 单配置全预算（评估口径） */
  fullBudget: number;
  /** 总预算 ≥ fullBudget（实际评估 min(⌊total/full⌋, 列表长度) 个配置） */
  totalBudget: number;
  seed?: number;
}

/** 全预算随机搜索结果 */
export interface RandomSearchResult<T> {
  bestConfig: T;
  bestScore: number;
  totalBudgetSpent: number;
  evaluations: ReadonlyArray<{ config: T; score: number; cumulativeBudget: number }>;
}

// ─────────────────────────── 内部工具 ───────────────────────────

/** 文件内确定性 RNG（mulberry32）——同种子同序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 幸存者数: 第 i 轮（预算 r_i）保留 ⌊n·r₀/r_i⌋（至少 1）。
 * 预算 ×η ⇒ 配置 ÷η 的几何交换; 直接从 (n, r₀, r_i) 计算（非迭代取整），
 * 与调度表逐位一致。
 *
 * 第五轮进化 [数值]: 整数域精确路径——n、r₀、r_i 全为整数且乘积在
 * 安全整数范围内时用整数取余整除（(p − p%ri)/ri 精确无浮点残差）；
 * 其余走浮点路径 + 1e-9 残差护栏（防 n·r₀/ri 恰落在整数下方的
 * 舍入尘埃翻转 floor）。
 */
function survivorCount(n: number, r0: number, ri: number): number {
  if (Number.isInteger(n) && Number.isInteger(r0) && Number.isInteger(ri) && Number.isSafeInteger(n * r0)) {
    const prod = n * r0;
    return Math.max(1, (prod - (prod % ri)) / ri);
  }
  return Math.max(1, Math.floor((n * r0) / ri + 1e-9));
}

function validateConfigs<T>(configs: ConfigSource<T>, who: string): void {
  if (typeof configs === 'function') return;
  if (Array.isArray(configs) && configs.length > 0) return;
  throw new Error(
    `${who}: configs 必须是非空数组或采样函数 (rng) => T，收到 ${Array.isArray(configs) ? '空数组' : typeof configs}`,
  );
}

function validateEta(eta: number, who: string): number {
  if (typeof eta !== 'number' || !Number.isFinite(eta) || eta <= 1) {
    throw new Error(`${who}: eta 必须是 > 1 的有限数，收到 ${String(eta)}`);
  }
  return eta;
}

function validateMaxBudget(maxBudget: number, who: string): number {
  if (typeof maxBudget !== 'number' || !Number.isFinite(maxBudget) || maxBudget < 1) {
    throw new Error(`${who}: maxBudget 必须 ≥ 1（保证 r_s = R·η^(−s) ≥ 1），收到 ${String(maxBudget)}`);
  }
  return maxBudget;
}

function validateSeed(seed: number | undefined, who: string): void {
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isFinite(seed))) {
    throw new Error(`${who}: seed 必须是有限数，收到 ${String(seed)}`);
  }
}

/** 有限列表 → 前 count 个的种子化洗牌（部分 Fisher-Yates，不修改原数组） */
function shuffledPrefix<T>(items: ReadonlyArray<T>, count: number, rng: () => number): T[] {
  const a = [...items];
  const take = Math.min(count, a.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (a.length - i));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a.slice(0, take);
}

// ─────────────────────────── bracket 闭式调度 ───────────────────────────

/**
 * Hyperband 闭式调度表（Li et al. 2017, Algorithm 1）。
 *
 * s_max = ⌊log_η R⌋（循环乘法求幂 + 1e-12 相对容差，避免 log 浮点尘埃）;
 * B = (s_max+1)·R; bracket s: n_s = ⌈(B/R)·η^s/(s+1)⌉、r_s = R·η^(−s)、
 * s+1 轮 successive halving。性质（验证锚点③）: 每轮成本交换不变
 * |c_{i+1} − c_i| < r_{i+1}; 每 bracket 预算 ∈ (B − ηR/(η−1), B + (s+1)·r_s];
 * Σ bracket 预算 = totalBudget。η=3、R=81 复现论文表 n=[81,34,15,8,5]。
 */
export function bracketSchedule(maxBudget: number, eta: number): HyperbandSchedule {
  const R = validateMaxBudget(maxBudget, 'bracketSchedule');
  const e = validateEta(eta, 'bracketSchedule');
  let sMax = 0;
  while (Math.pow(e, sMax + 1) <= R * (1 + 1e-12)) sMax += 1;
  const normalizerBudget = (sMax + 1) * R;
  const brackets: HyperbandScheduleBracket[] = [];
  for (let s = sMax; s >= 0; s -= 1) {
    const nConfigs = Math.ceil((normalizerBudget / R) * (Math.pow(e, s) / (s + 1)));
    const initialBudget = R / Math.pow(e, s);
    const rounds: HyperbandScheduleRound[] = [];
    for (let i = 0; i <= s; i += 1) {
      const perConfigBudget = initialBudget * Math.pow(e, i);
      const numConfigs = survivorCount(nConfigs, initialBudget, perConfigBudget);
      rounds.push({ round: i, numConfigs, perConfigBudget, cost: numConfigs * perConfigBudget });
    }
    const budget = rounds.reduce((acc, r) => acc + r.cost, 0);
    brackets.push({ s, nConfigs, initialBudget, rounds, budget });
  }
  const totalBudget = brackets.reduce((acc, b) => acc + b.budget, 0);
  return { eta: e, maxBudget: R, sMax, normalizerBudget, totalBudget, brackets };
}

// ─────────────────────────── SH 复用单元 ───────────────────────────

/**
 * 逐次减半复用单元（连续预算口径）。
 *
 * 命名避让: 73.0 BAI 已导出同名的 successiveHalving（Bernoulli 臂、固定样本
 * 预算均分），本内核的连续预算单元命名为 successiveHalvingUnit，防 export *
 * 合并冲突。candidates 依 budgets 序评估: 第 i 轮全体参赛者按预算 budgets[i]
 * 评估一次，保留 ⌊n·budgets[0]/budgets[i+1]⌋ 个（末轮裁到 1——冠军）;
 * 分数降序、平手按候选下标升序（确定性）。每轮成本 = 参赛数 × 该轮预算，
 * 几何交换下近似不变（|c_{i+1} − c_i| < budgets[i+1]）。
 */
export function successiveHalvingUnit<T>(
  candidates: ReadonlyArray<T>,
  budgets: ReadonlyArray<number>,
  evaluate: (config: T, budget: number) => number,
): ShResult<T> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(
      `successiveHalvingUnit: candidates 必须是非空数组，收到 ${candidates === null || candidates === undefined ? String(candidates) : `长度 ${candidates.length}`}`,
    );
  }
  if (typeof evaluate !== 'function') {
    throw new Error(`successiveHalvingUnit: evaluate 必须是函数，收到 ${typeof evaluate}`);
  }
  if (!Array.isArray(budgets) || budgets.length === 0) {
    throw new Error(`successiveHalvingUnit: budgets 必须是非空递增数组，收到 ${String(budgets)}`);
  }
  const bs: number[] = [];
  for (let i = 0; i < budgets.length; i += 1) {
    const b = budgets[i];
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) {
      throw new Error(`successiveHalvingUnit: budgets[${i}] 必须为正有限数，收到 ${String(b)}`);
    }
    if (i > 0 && b <= bs[i - 1]) {
      throw new Error(`successiveHalvingUnit: budgets 必须严格递增，budgets[${i}]=${String(b)} ≤ budgets[${i - 1}]=${String(bs[i - 1])}`);
    }
    bs.push(b);
  }
  const n = candidates.length;
  const r0 = bs[0];
  const last = bs.length - 1;
  let work = candidates.map((config, idx) => ({ config, idx }));
  const rounds: ShRound<T>[] = [];
  let bestObserved: ShBestObserved<T> = { config: candidates[0], score: -Infinity, budget: bs[0] };
  let totalCost = 0;
  let eliminated = 0;
  let winner: T = candidates[0];
  let winnerScore = 0;
  for (let i = 0; i <= last && work.length > 0; i += 1) {
    const budget = bs[i];
    const entries = work;
    const configs: T[] = [];
    const scores: number[] = [];
    for (const entry of entries) {
      const score = evaluate(entry.config, budget);
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error(`successiveHalvingUnit: evaluate 第 ${i} 轮返回非有限数: ${String(score)}`);
      }
      configs.push(entry.config);
      scores.push(score);
      if (score > bestObserved.score) bestObserved = { config: entry.config, score, budget };
    }
    // 排序: 分数降序、平手原候选下标升序
    const order = entries.map((_, k) => k).sort((a, b) => scores[b] - scores[a] || entries[a].idx - entries[b].idx);
    const keepCount = Math.min(i === last ? 1 : survivorCount(n, r0, bs[i + 1]), entries.length);
    const keptIdx = order.slice(0, keepCount);
    const survivors = keptIdx.map((k) => entries[k].config);
    eliminated += entries.length - keepCount;
    const cost = entries.length * budget;
    totalCost += cost;
    rounds.push({ round: i, perConfigBudget: budget, numConfigs: entries.length, cost, configs, scores, survivors });
    if (i === last) {
      winner = survivors[0];
      winnerScore = scores[keptIdx[0]];
    }
    work = keptIdx.map((k) => entries[k]);
  }
  return { rounds, winner, winnerScore, bestObserved, totalCost, eliminated };
}

// ─────────────────────────── hyperband 主循环 ───────────────────────────

/**
 * Hyperband 主循环（多预算自适应超参寻优）。
 *
 * 从 bracketSchedule 取闭式调度，逐 bracket（s_max → 0，探索端先行）抽
 * n_s 个 i.i.d. 配置（有限列表 = 有放回均匀抽样）跑 SH 复用单元; 全局最优
 * 取历代观察分数最大者（论文 "largest L seen so far"; 平手取最早）。预算
 * 纪律: totalBudgetSpent = schedule.totalBudget（逐配置预算加和，1e-9）。
 * 注意: bestScore 跨预算可比性由调用方 evaluate 口径保证（曲线族单调不减）。
 */
export function hyperband<T>(options: HyperbandOptions<T>): HyperbandResult<T> {
  if (typeof options.evaluate !== 'function') {
    throw new Error(`hyperband: evaluate 必须是函数，收到 ${typeof options.evaluate}`);
  }
  validateConfigs(options.configs, 'hyperband');
  const eta = validateEta(options.eta ?? 3, 'hyperband');
  const maxBudget = validateMaxBudget(options.maxBudget, 'hyperband');
  validateSeed(options.seed, 'hyperband');
  const rng = mulberry32(options.seed ?? 1);
  const source: ConfigSource<T> = options.configs;
  const sampler: () => T =
    typeof source === 'function'
      ? () => source(rng)
      : () => source[Math.floor(rng() * source.length)];
  const schedule = bracketSchedule(maxBudget, eta);
  const evaluations: HyperbandEvaluation<T>[] = [];
  const brackets: HyperbandBracketResult<T>[] = [];
  let cumulative = 0;
  for (const bracket of schedule.brackets) {
    const candidates: T[] = Array.from({ length: bracket.nConfigs }, () => sampler());
    const budgets = bracket.rounds.map((r) => r.perConfigBudget);
    const sh = successiveHalvingUnit(candidates, budgets, options.evaluate);
    for (const round of sh.rounds) {
      for (let i = 0; i < round.configs.length; i += 1) {
        cumulative += round.perConfigBudget;
        evaluations.push({
          bracket: bracket.s,
          round: round.round,
          config: round.configs[i],
          budget: round.perConfigBudget,
          score: round.scores[i],
          cumulativeBudget: cumulative,
        });
      }
    }
    brackets.push({
      s: bracket.s,
      nConfigs: bracket.nConfigs,
      initialBudget: bracket.initialBudget,
      rounds: sh.rounds,
      budget: sh.totalCost,
      winner: sh.winner,
      winnerScore: sh.winnerScore,
    });
  }
  let bestI = 0;
  for (let i = 1; i < evaluations.length; i += 1) {
    if (evaluations[i].score > evaluations[bestI].score) bestI = i;
  }
  return {
    bestConfig: evaluations[bestI].config,
    bestScore: evaluations[bestI].score,
    totalBudgetSpent: cumulative,
    brackets,
    evaluations,
    schedule,
  };
}

// ─────────────────────────── 学习曲线工厂 ───────────────────────────

/**
 * 凸饱和学习曲线: score(b) = q∞·(1−e^(−kb))。
 *
 * 单调不减、收益递减（边际质量随预算下降）、q∞ 与 k 配置相关。部分排序
 * 成立性由 k 带宽控制: 带宽窄 ⇒ 低预算排序 ≈ 全预算排序（锚点④ ρ > 0.8）;
 * 晚熟型（大 q∞ × 小 k）打破排序一致性——Hyperband 的诚实反例（锚点⑤）。
 */
export function saturationScore(finalQuality: number, rate: number, budget: number): number {
  if (typeof finalQuality !== 'number' || !Number.isFinite(finalQuality)) {
    throw new Error(`saturationScore: finalQuality 必须是有限数，收到 ${String(finalQuality)}`);
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`saturationScore: rate 必须是正有限数，收到 ${String(rate)}`);
  }
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
    throw new Error(`saturationScore: budget 必须是非负有限数，收到 ${String(budget)}`);
  }
  return finalQuality * (1 - Math.exp(-rate * budget));
}

/**
 * 学习曲线工厂: n 条凸饱和曲线，q∞ ~ U[quality], k ~ U[rate]（同 rng 流，
 * 同种子同曲线）; deception 时在末位（id = n−1）注入 1 条晚熟型反例
 * （缺省 q∞=1.0、k=0.1——全预算下最优、低预算下垫底的「排序翻转」配置）。
 */
export function learningCurveFactory(options: LearningCurveFactoryOptions): LearningCurve[] {
  const n = options.n;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
    throw new Error(`learningCurveFactory: n 必须是正整数，收到 ${String(n)}`);
  }
  validateSeed(options.seed, 'learningCurveFactory');
  const qRange = options.quality ?? [0.5, 0.95];
  if (!Array.isArray(qRange) || qRange.length !== 2) {
    throw new Error(`learningCurveFactory: quality 必须是 [lo, hi] 二元组`);
  }
  const qLo = qRange[0];
  const qHi = qRange[1];
  if (typeof qLo !== 'number' || !Number.isFinite(qLo) || qLo <= 0 || typeof qHi !== 'number' || !Number.isFinite(qHi) || qHi > 1 || qLo > qHi) {
    throw new Error(`learningCurveFactory: quality 需满足 0 < lo ≤ hi ≤ 1，收到 [${String(qLo)}, ${String(qHi)}]`);
  }
  const kRange = options.rate ?? [2.0, 3.0];
  if (!Array.isArray(kRange) || kRange.length !== 2) {
    throw new Error(`learningCurveFactory: rate 必须是 [lo, hi] 二元组`);
  }
  const kLo = kRange[0];
  const kHi = kRange[1];
  if (typeof kLo !== 'number' || !Number.isFinite(kLo) || kLo <= 0 || typeof kHi !== 'number' || !Number.isFinite(kHi) || kLo > kHi) {
    throw new Error(`learningCurveFactory: rate 需满足 0 < lo ≤ hi，收到 [${String(kLo)}, ${String(kHi)}]`);
  }
  const dec = options.deception;
  let deq: number | null = null;
  let dek: number | null = null;
  if (dec != null && dec !== false) {
    deq = typeof dec === 'object' ? (dec.finalQuality ?? 1) : 1;
    dek = typeof dec === 'object' ? (dec.rate ?? 0.1) : 0.1;
    if (typeof deq !== 'number' || !Number.isFinite(deq) || deq <= 0 || deq > 1) {
      throw new Error(`learningCurveFactory: deception.finalQuality 需在 (0,1] 内，收到 ${String(deq)}`);
    }
    if (typeof dek !== 'number' || !Number.isFinite(dek) || dek <= 0) {
      throw new Error(`learningCurveFactory: deception.rate 需为正有限数，收到 ${String(dek)}`);
    }
  }
  const rng = mulberry32(options.seed ?? 1);
  const curves: LearningCurve[] = [];
  for (let i = 0; i < n; i += 1) {
    const isLate = deq !== null && i === n - 1;
    const finalQuality = isLate ? (deq as number) : qLo + rng() * (qHi - qLo);
    const rate = isLate ? (dek as number) : kLo + rng() * (kHi - kLo);
    curves.push({
      id: i,
      finalQuality,
      rate,
      lateBloomer: isLate,
      score: (budget: number) => saturationScore(finalQuality, rate, budget),
    });
  }
  return curves;
}

// ─────────────────────────── 全预算随机搜索对照 ───────────────────────────

/**
 * 全预算随机搜索对照（基线）。
 *
 * 有限列表: 种子化洗牌后按序评估 min(⌊totalBudget/fullBudget⌋, 列表长度)
 * 个（不重复——「随机顺序的全量搜索」口径）; 采样器: i.i.d. 抽取。每配置
 * 一次性 fullBudget 全预算，无任何提前终止——把预算均摊给注定出局的配置，
 * 与 Hyperband 的「早停 + 集中」形成行为对照（锚点①②）。
 */
export function randomSearchFullBudget<T>(options: RandomSearchOptions<T>): RandomSearchResult<T> {
  if (typeof options.evaluate !== 'function') {
    throw new Error(`randomSearchFullBudget: evaluate 必须是函数，收到 ${typeof options.evaluate}`);
  }
  validateConfigs(options.configs, 'randomSearchFullBudget');
  const fullBudget = options.fullBudget;
  if (typeof fullBudget !== 'number' || !Number.isFinite(fullBudget) || fullBudget <= 0) {
    throw new Error(`randomSearchFullBudget: fullBudget 必须为正有限数，收到 ${String(fullBudget)}`);
  }
  const totalBudget = options.totalBudget;
  if (typeof totalBudget !== 'number' || !Number.isFinite(totalBudget) || totalBudget < fullBudget) {
    throw new Error(`randomSearchFullBudget: totalBudget 必须 ≥ fullBudget，收到 ${String(totalBudget)} < ${String(fullBudget)}`);
  }
  validateSeed(options.seed, 'randomSearchFullBudget');
  const rng = mulberry32(options.seed ?? 1);
  const count = Math.floor(totalBudget / fullBudget);
  const source: ConfigSource<T> = options.configs;
  const sampler: () => T =
    typeof source === 'function'
      ? () => source(rng)
      : () => source[Math.floor(rng() * source.length)];
  const order: T[] =
    typeof source === 'function'
      ? Array.from({ length: count }, sampler)
      : shuffledPrefix(source, count, rng);
  const evaluations: { config: T; score: number; cumulativeBudget: number }[] = [];
  let cumulative = 0;
  let bestI = 0;
  for (let i = 0; i < order.length; i += 1) {
    const score = options.evaluate(order[i], fullBudget);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`randomSearchFullBudget: evaluate 第 ${i} 个配置返回非有限数: ${String(score)}`);
    }
    cumulative += fullBudget;
    evaluations.push({ config: order[i], score, cumulativeBudget: cumulative });
    if (score > evaluations[bestI].score) bestI = i;
  }
  return {
    bestConfig: order[bestI],
    bestScore: evaluations[bestI].score,
    totalBudgetSpent: cumulative,
    evaluations,
  };
}

// ─────────────────────────── Spearman 秩相关 ───────────────────────────

/** 平均秩（并列取平均） */
function averageRanks(values: ReadonlyArray<number>): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman 秩相关 ρ（并列平均秩）。锚点④的「低预算排序 vs 全预算排序」
 * 部分保持度读数; 任一侧零方差（全并列）时 ρ 无定义 → throw（诚实）。
 */
export function spearmanRho(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length < 2) {
    throw new Error(`spearmanRho: 需要两个等长（≥2）数值数组，收到 ${String(x?.length)}/${String(y?.length)}`);
  }
  for (let i = 0; i < x.length; i += 1) {
    if (typeof x[i] !== 'number' || !Number.isFinite(x[i]) || typeof y[i] !== 'number' || !Number.isFinite(y[i])) {
      throw new Error(`spearmanRho: x[${i}]/y[${i}] 必须是有限数`);
    }
  }
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += rx[i];
    my += ry[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const ax = rx[i] - mx;
    const ay = ry[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  if (dx === 0 || dy === 0) {
    throw new Error(`spearmanRho: 输入存在零方差（全部并列），ρ 无定义`);
  }
  return num / Math.sqrt(dx * dy);
}

// ─────────────────── η 扫描理论（第五轮进化） ───────────────────

/** η 扫描行：给定 (R, η) 的解析账本 */
export interface EtaSweepRow {
  eta: number;
  sMax: number;
  bracketCount: number;
  /** 实际总预算 = Σ bracket 预算（取整松弛诚实入账） */
  totalBudget: number;
  /** 名义预算 R·(s_max+1)²（连续松弛定理值） */
  nominalBudget: number;
  /** |total − nominal| / nominal（取整松弛占比） */
  roundingSlack: number;
  /** 检视的不同配置数 Σ_s n_s（探索广度——随 η 单调下降） */
  configsExamined: number;
  /** 各预算档的评估槽数（budget 升序；slots = Σ 该档轮的 numConfigs） */
  slotsByBudget: Array<{ budget: number; slots: number }>;
}

/**
 * Hyperband 的最优 η 理论扫描（etaSweep）：
 *
 * 名义总预算 = (s_max+1)·B = R·(s_max+1)²（s_max = ⌊log_η R⌋）；实际
 * 总预算在取整松弛带内（每 bracket 预算 ∈ (B − ηR/(η−1), B+(s+1)r_s]）。
 * η 的谱系语义：η 小 → s_max 大 → bracket 多 → configsExamined 大
 * （探索广度，总体随 η 收缩——s_max 台阶处非严格）且高保真档槽数
 * 多（晚熟型露头机会）；η 大 → 集中于激进 SH（开发深度）。η 不是
 * 超参而是显式权衡——本函数给出逐 η 的账本。
 */
export function etaSweep(maxBudget: number, options?: { etas?: number[] }): EtaSweepRow[] {
  const R = validateMaxBudget(maxBudget, 'etaSweep');
  const etas = options?.etas ?? [2, 3, 4, 5, 6];
  if (!Array.isArray(etas) || etas.length === 0) {
    throw new Error(`etaSweep: etas 须为非空数组（收到 ${String(etas)}）`);
  }
  const rows: EtaSweepRow[] = [];
  for (const eta of etas) {
    const e = validateEta(eta, 'etaSweep');
    const schedule = bracketSchedule(R, e);
    const nominal = R * (schedule.sMax + 1) ** 2;
    const slotMap = new Map<number, number>();
    let configsExamined = 0;
    for (const bracket of schedule.brackets) {
      configsExamined += bracket.nConfigs;
      for (const round of bracket.rounds) {
        slotMap.set(round.perConfigBudget, (slotMap.get(round.perConfigBudget) ?? 0) + round.numConfigs);
      }
    }
    const slotsByBudget = [...slotMap.entries()]
      .map(([budget, slots]) => ({ budget, slots }))
      .sort((a, b) => a.budget - b.budget);
    rows.push({
      eta: e,
      sMax: schedule.sMax,
      bracketCount: schedule.brackets.length,
      totalBudget: schedule.totalBudget,
      nominalBudget: nominal,
      roundingSlack: Math.abs(schedule.totalBudget - nominal) / nominal,
      configsExamined,
      slotsByBudget,
    });
  }
  return rows;
}

// ─────────────────── 异步 bracket：资源感知调度（第五轮进化） ───────────────────

/** 一个可执行评估任务（bracket s 的第 round 轮第 slot 槽位） */
export interface AsyncHyperbandTask<T> {
  bracket: number;
  round: number;
  /** 槽位 = 该配置在 bracket 内的 round-0 下标（幸存者全程保留原下标——确定性平手规则） */
  slot: number;
  config: T;
  budget: number;
}

/** 异步 hyperband 选项 */
export interface AsyncHyperbandOptions<T> {
  /** 单配置最大预算 R ≥ 1 */
  maxBudget: number;
  /** 淘汰率 η > 1，缺省 3 */
  eta?: number;
  /** 并行 worker 上限（≥ 1，缺省 1）——在飞任务永不超此数 */
  workers?: number;
  /** 配置来源（每 bracket 的 round-0 抽样；与 hyperband() 同种子同抽样序） */
  configs: ConfigSource<T>;
  /** RNG 种子（缺省 1） */
  seed?: number;
}

/** 异步执行完成后的单 bracket 读出 */
export interface AsyncBracketResult<T> {
  s: number;
  rounds: number;
  winner: T;
  winnerScore: number;
}

interface AsyncBracketState<T> {
  s: number;
  budgets: number[];
  configs: T[];
  /** 当前轮参与者（round-0 下标，按幸存规则保留） */
  participants: number[];
  round: number;
  /** 本轮已签发未回报的 slot 集合 */
  outstanding: Set<number>;
  /** 本轮已回报的 slot → score */
  scores: Map<number, number>;
  done: boolean;
  winnerSlot: number;
  winnerScore: number;
}

/**
 * 异步 bracket（资源感知调度）：hyperband() 的同步主循环任务流化。
 *
 * - nextTasks(k)：签发至多 k 个就绪任务——round 屏障（bracket 内
 *   下一轮参与者依赖本轮全部成绩，未齐不签发）+ worker 上限
 *   （outstanding 总数 < workers）+ 确定性签发序（schedule 序 = 探索
 *   端 s 大优先，bracket 内 round/slot 升序）；
 * - report(task, score)：回收成绩；本轮齐 → 按分数降序（平手 slot
 *   升序，与 SH 的候选下标规则一致）裁出幸存者，推进到下一轮；
 * - 完成时 budgetIssued() === schedule.totalBudget（预算守恒——
 *   签发即记账）；workers 充裕 + FIFO 回报时逐 bracket 复现
 *   hyperband() 的幸存者/冠军（等价锚）。
 */
export class AsyncHyperband<T> {
  private readonly schedule: HyperbandSchedule;
  private readonly workers: number;
  private readonly brackets: AsyncBracketState<T>[];
  private budgetIssuedValue = 0;
  private best: { config: T; score: number; budget: number } | null = null;

  constructor(options: AsyncHyperbandOptions<T>)  {
    validateConfigs(options.configs, 'AsyncHyperband');
    const eta = validateEta(options.eta ?? 3, 'AsyncHyperband');
    const maxBudget = validateMaxBudget(options.maxBudget, 'AsyncHyperband');
    validateSeed(options.seed, 'AsyncHyperband');
    const workers = Math.floor(options.workers ?? 1);
    if (!(workers >= 1)) {
      throw new Error(`AsyncHyperband: workers 必须 ≥ 1（收到 ${options.workers}）`);
    }
    this.workers = workers;
    const rng = mulberry32(options.seed ?? 1);
    const source: ConfigSource<T> = options.configs;
    const sampler: () => T =
      typeof source === 'function'
        ? () => source(rng)
        : () => source[Math.floor(rng() * source.length)];
    this.schedule = bracketSchedule(maxBudget, eta);
    // round-0 配置按 schedule 序（s 大→小）预抽——与 hyperband() 同种子同抽样序（等价锚）
    this.brackets = this.schedule.brackets.map((bracket) => ({
      s: bracket.s,
      budgets: bracket.rounds.map((r) => r.perConfigBudget),
      configs: Array.from({ length: bracket.nConfigs }, () => sampler()),
      participants: Array.from({ length: bracket.nConfigs }, (_, i) => i),
      round: 0,
      outstanding: new Set<number>(),
      scores: new Map<number, number>(),
      done: false,
      winnerSlot: -1,
      winnerScore: 0,
    }));
  }

  /** 是否全部 bracket 完成 */
  get done(): boolean {
    return this.brackets.every((b) => b.done);
  }

  /** 在飞任务数 */
  inFlight(): number {
    return this.brackets.reduce((acc, b) => acc + b.outstanding.size, 0);
  }

  /** 已签发任务的总预算（完成时 === schedule.totalBudget，1e-9） */
  budgetIssued(): number {
    return this.budgetIssuedValue;
  }

  /** 历代已回报的最大分数（含中间轮；平手取最早签发） */
  bestObserved(): { config: T; score: number; budget: number } | null {
    return this.best === null ? null : { config: this.best.config, score: this.best.score, budget: this.best.budget };
  }

  /**
   * 签发至多 count 个就绪任务（round 屏障 + worker 上限 + 确定性
   * 签发序：schedule 序探索端优先，bracket 内按幸存者序（分数降序、
   * 平手 slot 升序——与 SH 的评估序同构）逐槽签发）。
   */
  nextTasks(count = 1): AsyncHyperbandTask<T>[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`AsyncHyperband.nextTasks: count 须为 ≥1 的整数（收到 ${count}）`);
    }
    const tasks: AsyncHyperbandTask<T>[] = [];
    for (const bracket of this.brackets) {
      if (tasks.length >= count || this.inFlight() >= this.workers) break;
      if (bracket.done) continue;
      const budget = bracket.budgets[bracket.round]!;
      for (const slot of bracket.participants) {
        if (bracket.scores.has(slot)) continue; // 本轮已回收（重复评估防）
        if (tasks.length >= count || this.inFlight() >= this.workers) break;
        if (bracket.outstanding.has(slot)) continue; // 已签发在飞
        bracket.outstanding.add(slot);
        this.budgetIssuedValue += budget;
        tasks.push({ bracket: bracket.s, round: bracket.round, slot, config: bracket.configs[slot]!, budget });
      }
    }
    return tasks;
  }

  /** 回收一个任务的成绩（须为已签发在飞的任务；非法回报显式 throw） */
  report(task: { bracket: number; round: number; slot: number }, score: number): void {
    if (task === null || typeof task !== 'object') {
      throw new Error('AsyncHyperband.report: 需要 {bracket, round, slot} 任务与 score');
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`AsyncHyperband.report: score 须为有限数（收到 ${String(score)}）`);
    }
    const bracket = this.brackets.find((b) => b.s === task.bracket);
    if (bracket === undefined) {
      throw new Error(`AsyncHyperband.report: 未知 bracket s=${String(task.bracket)}`);
    }
    if (bracket.done || bracket.round !== task.round) {
      throw new Error(`AsyncHyperband.report: bracket ${task.bracket} 的第 ${task.round} 轮已闭合（当前第 ${bracket.round} 轮）——不可迟报`);
    }
    if (!bracket.outstanding.has(task.slot) || bracket.scores.has(task.slot)) {
      throw new Error(`AsyncHyperband.report: slot ${task.slot} 不在 bracket ${task.bracket} 第 ${task.round} 轮的在飞集合中`);
    }
    bracket.outstanding.delete(task.slot);
    bracket.scores.set(task.slot, score);
    if (this.best === null || score > this.best.score) {
      this.best = { config: bracket.configs[task.slot]!, score, budget: bracket.budgets[bracket.round]! };
    }
    // 本轮全部参与者成绩齐 → 裁幸存者、推进（round 屏障）
    if (bracket.scores.size === bracket.participants.length) {
      const last = bracket.round === bracket.budgets.length - 1;
      const ordered = [...bracket.scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (last) {
        bracket.done = true;
        bracket.winnerSlot = ordered[0]![0];
        bracket.winnerScore = ordered[0]![1];
        return;
      }
      const nextBudget = bracket.budgets[bracket.round + 1]!;
      const keep = Math.min(survivorCount(bracket.configs.length, bracket.budgets[0]!, nextBudget), ordered.length);
      bracket.participants = ordered.slice(0, keep).map(([slot]) => slot);
      bracket.round += 1;
      bracket.scores = new Map<number, number>();
    }
  }

  /** 全部 bracket 的最终读出（未完成时显式 throw——诚实边界） */
  bracketResults(): AsyncBracketResult<T>[] {
    if (!this.done) throw new Error('AsyncHyperband.bracketResults: 尚有 bracket 未完成（先跑完 nextTasks/report 循环）');
    return this.brackets.map((b) => ({
      s: b.s,
      rounds: b.budgets.length,
      winner: b.configs[b.winnerSlot]!,
      winnerScore: b.winnerScore,
    }));
  }
}

// ─────────────────── 93.0 接线建议（挂载侧的语义桥） ───────────────────
// 1. 元认知引擎调参自动化: 17 引擎的超参（阈值/窗口/学习率）从手工配置升级为
//    Hyperband 自动寻优——evaluate(config, budget) = benchmark 沙盒按预算缩放
//    的质量分，budget 口径 = 评测 prompt 条数 / epoch 数 / 数据子采样率
//    （1 单位 = 1 条）。沙盒必须支持「同一配置按 budget 缩放评测」，否则
//    问题退化为 73.0 BAI 的离散臂一次性评估场景（用错内核）。
// 2. 与 73.0 BAI 的分工: BAI 选离散臂、每臂一次性全量评估、结论最优
//    （「哪个引擎是冠军」）; 本内核管连续配置空间 × 可提前终止的全预算曲线
//    （「哪组超参最强」）——引擎层用 BAI、引擎内超参层用本内核，两层正交。
// 3. evaluate 的跨预算可比性: bestScore 取「历代观察最大」——要求 score 随
//    budget 单调不减（学习曲线族天然满足）; 接线侧自检: 同配置
//    evaluate(c, 2b) ≥ evaluate(c, b)。
// 4. 预算审计: totalBudgetSpent === schedule.totalBudget（逐配置预算加和，
//    1e-9）; evaluations 末条 cumulativeBudget 即总开销——调用方据此对账沙盒
//    成本; 有限列表按有放回 i.i.d. 抽样（论文口径），需不重复时在 sampler
//    侧维护去重池。
// 5. 欺骗性曲线（晚熟型）防御: 若领域知识提示「慢热配置更优」（如需要 warmup
//    的学习率调度），提高最小初始预算（只用低 s 的 bracket——牺牲探索换
//    保真），或先跑 randomSearchFullBudget 对照兜底; 检测信号 = 曲线族
//    spearmanRho(score@低预算, score@全预算) 偏低时降级到全预算口径。
