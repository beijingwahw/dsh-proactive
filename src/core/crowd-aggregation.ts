/**
 * crowd-aggregation.ts — 82.0 众包聚合内核（Dawid–Skene 潜变量 EM：人人一票 → 信任投票）
 *
 * 动机（升级前的根本局限）:
 * - 多模型/多评分者对同一判定的输出聚合只有「多数票 / 平均」两种武器，
 *   两者都把专家、僵尸与对抗者一视同仁——一人一票等于把噪声请上主席台:
 *   垃圾回答者（均匀乱标）稀释专家票，系统性反指者（总选错误项）反而
 *   双倍作恶（既投错票又把票型拉离真值）；
 * - 「谁在哪个类别上可信」没有任何学习口径: 模型 A 擅长代码、模型 B
 *   擅长数学，但聚合器只数手数不看手质量——混淆矩阵（哪个模型把哪类
 *   问题答成哪类）从未被估计过；
 * - 先验不均衡时多数票系统性追随多数类: 90% 的样本是类 0 时，误差
 *   质量流向类 0 的弱评分者把少数类成批吞并——「群体智慧」退化为
 *   「基数暴力」，且无自愈机制；
 * - 加权投票的权重是拍脑袋给的: 想按可信度加权，可信度本身没有
 *   估计量。
 *
 * 数学（Dawid–Skene 1979 多评分者潜变量 EM；Snow et al. 2008 把它
 * 带回众包、Whitehill et al. 2009 GLAD 为其近亲）:
 *
 *   观测: W 个 worker × I 个 item 的标签矩阵 y^w_i ∈ {0..C−1}
 *   （可缺失——某 worker 未标某 item 记 null，似然中直接跳过）；
 *   潜变量: 每个 item 的真值 z_i ∈ {0..C−1}；
 *   参数: 每 worker 的混淆矩阵 π^w（C×C 行随机: π^w[j][l] =
 *   P(w 报出 l | 真值 j)，对角线 = 该 worker 在该类上的准确率）
 *   与类别先验 p(z)。
 *
 *   观测对数似然（item 条件独立、worker 给定真值条件独立）:
 *     LL = Σ_i log Σ_j p_j · Π_{w: y^w_i 非缺失} π^w[j][y^w_i]
 *
 *   E 步（responsibility，log 域 + log-sum-exp 防下溢）:
 *     γ_ij ∝ p_j · Π_w π^w[j][y^w_i]   （z_i = j 的后验）
 *
 *   M 步（闭式极大化，可选伪计数 s 平滑——类别先验平滑防零单元）:
 *     π^w_jl = (Σ_i γ_ij·1[y^w_i=l] + s) / (Σ_i γ_ij + s·C)
 *     p_j    = (Σ_i γ_ij + s) / (I + s·C)
 *
 *   EM 保证: 逐轮 LL 单调不减；初始化用多数票硬指派做一次 M 步
 *   （Dawid–Skene 经典启动），好人 ≥ 2 时模型可辨识、DS 是一致估计
 *   （信噪比: 每类 n 个样本时二项 SE ≈ sqrt(p(1−p)/n)，验证锚点②
 *   按此文档化取 600 items ⇒ 每类 ≈ 200 ⇒ SE ≈ 0.03）。
 *
 *   基线与衍生: 多数票（等权）/ 加权多数票（显式票权）为对照组；
 *   信任票权 reliability_w = Σ_j p_j·π^w[j][j]——把学到的混淆矩阵
 *   压成「先验加权的对角质量」，直接喂加权投票：垃圾者收敛到均匀
 *   ⇒ 票权 ≈ 1/C，对抗者对角塌陷 ⇒ 票权趋 0，无用者被数学降权
 *   而非规则降权。仿真工厂（文件内 mulberry32）提供混淆矩阵谱:
 *   好人近单位阵 / 中等 / 垃圾均匀 / 对抗者循环反指 / 随机坏人，
 *   显式混淆矩阵可整体覆盖。
 *
 * 验证锚点:
 *   ① 混合 crowd（2 好 0.9 对角、1 垃圾均匀、1 对抗 0.15 循环反指、
 *     1 中等 0.6）× 100 items × 3 类均匀: DS 恢复真值准确率 ≥ 0.97
 *     且高出多数票 ≥ 8 个百分点（垃圾+对抗把多数票拉到 ~0.6 档）；
 *   ② 混淆矩阵恢复: 同 crowd 600 items（每类 ≈ 200，二项 SE ≈ 0.03
 *     ——信噪比文档化），全部 5×3×3 单元 |π̂ − π| ≤ 0.1；
 *   ③ EM 对数似然逐轮单调不减（EM 定理的实证检查，浮点容差 1e-9）；
 *   ④ 垃圾 worker 的 π̂ ≈ 均匀（自动识别无用者），信任度排序
 *     好 > 中 > 垃圾 > 对抗，对抗者被识破为系统性反指；
 *   ⑤ 先验 90/7/3 + 误差质量流向多数类的偏置 crowd（300 items）:
 *     多数票少数类召回系统性塌方，DS 用学到的混淆矩阵校正（少数类
 *     召回差距断言 + 类别先验恢复）。
 *
 * R5 进化（第五轮·世界性升级，数学+性能+数值三轴）:
 *   数学轴——已知混淆下的贝叶斯最优聚合（bayesianAggregate）: 混淆矩阵
 *     与先验**已知**（历史拟合值/平台审计值）时，E 步的闭式后验
 *     γ_ij ∝ p_j·Π_w π^w[j][y^w_i] 直接就是 MAP 判决——对数域
 *     log-sum-exp 一步出全部后验，不跑 EM。性质: 在生成模型正确时该
 *     判决最小化 0-1 损失（贝叶斯最优）; 对抗者被**反演**（循环反指的
 *     混淆行把 P(报 j+1|真 j)=0.85 变成似然比证据——反指者=金矿）。
 *     与 DS 的分工: 参数未知 → EM 学参数; 参数已知 → 一步贝叶斯。
 *   性能轴——EM 对数表提升: eStep/logLikelihood 原先对每个 (item,
 *     class, worker) 各调一次 safeLog（每轮 2·I·C·W 次 Math.log + 1e-300
 *     比较），而 π 在轮内不变——提升为每轮构建一次 log π 表
 *     （W·C² 次），两处复用查表。**逐位等价**: 查表值 = safeLog(同参)
 *     的缓存，加法序不变——EM 轨迹/最终估计逐位相同（既有锚点全保），
 *     耗时对照见 verify-r5-game（vs 脚本内朴素参考实现）。
 *   数值轴——bayesianAggregate 全程对数域（safeLog 1e-300 地板 +
 *     log-sum-exp 防下溢）: 长标注向量/极端混淆下线性域连乘必下溢，
 *     对数域稳定。
 *
 * 应用: 多模型输出聚合——模型投票从「人人一票」升级为「按历史混淆
 * 矩阵加权的信任投票」: 哪个模型在哪类问题上可信，EM 从投票记录里
 * 自己学出来（判断层的群体智慧口径，与 81.0 论证的对抗口径互补:
 * 81.0 审「谁在使坏」，82.0 学「谁在哪里可信」）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 公共类型 ───────────────────────────

/** 众包标注观测: W 个 worker × I 个 item 的标签矩阵（行主序；null = 缺失） */
export interface CrowdsourcedLabels {
  /** worker id 表（长度 = labels 行数） */
  workers: string[];
  /** 类别数 C（标签取 0..C−1） */
  classes: number;
  /** labels[w][i]: worker w 对 item i 的标签；null = 该 worker 未标注该 item */
  labels: (number | null)[][];
}

/** Dawid–Skene EM 选项 */
export interface DawidSkeneOptions {
  /** 最大 EM 轮数（缺省 50） */
  iters?: number;
  /** 对数似然增量收敛容差（缺省 1e-8） */
  tol?: number;
  /** M 步伪计数平滑 s（缺省 0.01；0 = 纯 MLE，零单元由 1e-300 log 地板防护） */
  smoothing?: number;
}

/** Dawid–Skene 拟合报告 */
export interface DawidSkeneResult {
  /** 真值后验 γ_ij（I × C，行和 1） */
  truthPosterior: number[][];
  /** 后验 argmax 硬指派（平票取小类号） */
  estimatedLabels: number[];
  /** 每 worker 混淆矩阵 π̂^w（W × C × C，行 = 真值 j，列 = 报出 l，行和 1） */
  confusionMatrices: number[][][];
  /** 类别先验估计 p̂(z)（长度 C，和 1） */
  classPrior: number[];
  /** 信任票权: 先验加权的对角质量 Σ_j p̂_j·π̂^w_jj */
  workerReliability: number[];
  /** 观测对数似然轨迹（长度 = iterations + 1，含初始化后首值；逐轮单调不减） */
  logLikTrace: number[];
  /** 实际执行的 EM 轮数（初始化 M 步不计） */
  iterations: number;
  size: { workers: number; items: number; classes: number };
  interpretation: string;
}

/** worker 原型谱（const 对象 + 类型，strip-types 兼容不用 enum） */
export const WORKER_ARCHETYPES = {
  good: 'good',
  medium: 'medium',
  adversarial: 'adversarial',
  spammer: 'spammer',
  random: 'random',
} as const;

export type WorkerArchetype = keyof typeof WORKER_ARCHETYPES;

/** 仿真 worker 规格（显式 confusion 整体覆盖原型数值） */
export interface CrowdWorkerSpec {
  archetype?: WorkerArchetype;
  /** 显式混淆矩阵（C×C 行随机；给出则忽略 archetype/diagonal） */
  confusion?: number[][];
  /** 原型对角强度覆盖（good 缺省 0.9 / medium 0.6 / adversarial 0.15 / spammer 1/C 均匀） */
  diagonal?: number;
  /** 覆盖率 ∈ [0,1]（缺省 1 = 全标；<1 按种子随机置 null） */
  coverage?: number;
}

/** 众包仿真规格 */
export interface CrowdSimulationSpec {
  workers: readonly CrowdWorkerSpec[];
  /** item 数 */
  items: number;
  /** 类别数（缺省 3；classPrior / 显式 confusion 可另行约束，冲突抛错） */
  classes?: number;
  /** 真值类别先验（缺省均匀） */
  classPrior?: readonly number[];
  /** 随机种子（文件内 mulberry32，同种子同输出） */
  seed: number;
}

/** 仿真产物: 标注 + 全部地面真值（混淆矩阵谱与真值标签，供锚点对照） */
export interface SimulatedCrowd {
  truth: number[];
  labels: CrowdsourcedLabels;
  /** 生成所用的真值混淆矩阵（W × C × C） */
  confusions: number[][][];
  classPrior: number[];
  coverage: number[];
}

// ─────────────────────────── 基线聚合 ───────────────────────────

/**
 * 多数票基线（等权一人一票）: 每 item 取计票最高的类；
 * 平票取类号最小者（确定性）。垃圾/对抗者与专家同权——本内核的对照组。
 */
export function majorityVote(labels: CrowdsourcedLabels): number[] {
  const geo = checkLabels(labels);
  const out = new Array<number>(geo.items);
  for (let i = 0; i < geo.items; i += 1) {
    const counts = new Array<number>(geo.classes).fill(0);
    for (let w = 0; w < geo.workers; w += 1) {
      const v = labels.labels[w]![i]!;
      if (v !== null) counts[v] += 1;
    }
    out[i] = argmaxTieSmallest(counts);
  }
  return out;
}

/**
 * 加权多数票: score_c = Σ_w weights_w·1[y^w_i = c]，argmax（平票取小类号）。
 * 票权可来自 reliabilityWeights（DS 学到的信任度）——「信任投票」的轻量路径。
 */
export function weightedMajority(labels: CrowdsourcedLabels, weights: readonly number[]): number[] {
  const geo = checkLabels(labels);
  if (!Array.isArray(weights) || weights.length !== geo.workers) {
    throw new Error(`weightedMajority: weights 长度 ${weights?.length} ≠ workers ${geo.workers}（票权逐 worker 给定）`);
  }
  for (let w = 0; w < weights.length; w += 1) {
    const x = weights[w]!;
    if (!Number.isFinite(x) || x < 0) throw new Error(`weightedMajority: weights[${w}] = ${x} 非法（需要有限非负）`);
  }
  if (weights.reduce((a, b) => a + b, 0) <= 1e-12) throw new Error('weightedMajority: weights 全零——没有任何票权可用');
  const out = new Array<number>(geo.items);
  for (let i = 0; i < geo.items; i += 1) {
    const scores = new Array<number>(geo.classes).fill(0);
    for (let w = 0; w < geo.workers; w += 1) {
      const v = labels.labels[w]![i]!;
      if (v !== null) scores[v] += weights[w]!;
    }
    out[i] = argmaxTieSmallest(scores);
  }
  return out;
}

/** 估计准确率: 逐位相等频率（真值 vs 估计标签） */
export function estimateAccuracy(truth: readonly number[], estimate: readonly number[]): number {
  if (!Array.isArray(truth) || !Array.isArray(estimate) || truth.length !== estimate.length) {
    throw new Error(`estimateAccuracy: truth/estimate 长度应相等（${truth?.length} vs ${estimate?.length}）`);
  }
  if (truth.length === 0) throw new Error('estimateAccuracy: 空数组无法估计准确率');
  for (let i = 0; i < truth.length; i += 1) {
    if (!Number.isInteger(truth[i]) || truth[i]! < 0 || !Number.isInteger(estimate[i]) || estimate[i]! < 0) {
      throw new Error(`estimateAccuracy: 第 ${i} 位标签非非负整数（truth=${truth[i]}, estimate=${estimate[i]}）`);
    }
  }
  let hit = 0;
  for (let i = 0; i < truth.length; i += 1) if (truth[i] === estimate[i]!) hit += 1;
  return hit / truth.length;
}

// ─────────────────────────── Dawid–Skene EM ───────────────────────────

/**
 * Dawid–Skene 多评分者潜变量 EM。
 *
 * 用法:
 *   const { labels } = simulateCrowd({ workers: CROWD, items: 100, seed: 42 });
 *   const fit = dawidSkene(labels, { iters: 60, tol: 1e-9 });
 *   // fit.estimatedLabels      —— 真值估计（垃圾/对抗者被自动降权）
 *   // fit.confusionMatrices[w] —— w 的混淆矩阵估计（谁在哪个类上可信）
 *   // fit.logLikTrace          —— 逐轮单调不减的观测对数似然
 *
 * 初始化: 多数票硬指派 → 一次 M 步得 θ₀（经典 DS 启动）；随后 E/M 交替，
 * 每轮后记录 LL(θ_t)——EM 保证轨迹单调不减。
 */
export function dawidSkene(labels: CrowdsourcedLabels, options?: DawidSkeneOptions): DawidSkeneResult {
  const geo = checkLabels(labels);
  const iters = options?.iters ?? 50;
  if (!Number.isInteger(iters) || iters < 1 || iters > 100000) {
    throw new Error(`dawidSkene: iters 需要 1..100000 的整数（收到 ${iters}）`);
  }
  const tol = options?.tol ?? 1e-8;
  if (!Number.isFinite(tol) || tol <= 0) throw new Error(`dawidSkene: tol 需要有限正数（收到 ${tol}）`);
  const s = options?.smoothing ?? 0.01;
  if (!Number.isFinite(s) || s < 0) throw new Error(`dawidSkene: smoothing 需要 ≥ 0 的有限数（收到 ${s}）`);

  const Y = labels.labels;
  // 初始化: 多数票硬 one-hot → M 步得 θ₀
  const mv = majorityVote(labels);
  let gamma: number[][] = Array.from({ length: geo.items }, (_, i) =>
    Array.from({ length: geo.classes }, (_, j) => (mv[i] === j ? 1 : 0)),
  );
  let prior = mStepPrior(gamma, s);
  let pi = mStepConfusion(Y, gamma, s);

  // EM 主循环（trace[0] = LL(θ₀)，此后每轮 push LL(θ_t)，单调不减）。
  // R5 性能轴: 每轮构建一次 log π / log prior 表，eStep 与 logLikelihood
  // 共享查表（值 = safeLog(同参) 的缓存，算术序不变 → 结果逐位相同）。
  const trace: number[] = [logLikelihood(Y, buildLogTables(prior, pi))];
  let iterations = 0;
  for (let t = 1; t <= iters; t += 1) {
    const tables = buildLogTables(prior, pi);
    gamma = eStep(Y, tables);
    prior = mStepPrior(gamma, s);
    pi = mStepConfusion(Y, gamma, s);
    const ll = logLikelihood(Y, buildLogTables(prior, pi));
    trace.push(ll);
    iterations = t;
    if (Math.abs(ll - trace[trace.length - 2]!) < tol) break;
  }

  const estimatedLabels = gamma.map((row) => argmaxTieSmallest(row));
  const workerReliability = pi.map((m) => prior.reduce((acc, p, j) => acc + p * m[j]![j]!, 0));
  const ranked = labels.workers
    .map((id, w) => ({ id, rel: workerReliability[w]! }))
    .sort((a, b) => b.rel - a.rel);
  return {
    truthPosterior: gamma.map((row) => row.map(round)),
    estimatedLabels,
    confusionMatrices: pi.map((m) => m.map((row) => row.map(round))),
    classPrior: prior.map(round),
    workerReliability: workerReliability.map(round),
    logLikTrace: trace.map(round),
    iterations,
    size: { workers: geo.workers, items: geo.items, classes: geo.classes },
    interpretation:
      `EM ${iterations} 轮: 观测对数似然 ${round(trace[0]!)} → ${round(trace[trace.length - 1]!)}（单调不减）；` +
      `信任度序 ${ranked.map((r) => `${r.id}(${r.rel.toFixed(2)})`).join(' > ')}——` +
      `低信任者在 E 步被自动降权，垃圾者的混淆矩阵收敛到均匀（票权 ≈ 1/C）`,
  };
}

/** R5 性能轴: 每轮一次的 log 表（log prior + log π）——eStep/logLikelihood 查表复用 */
interface LogTables {
  logPrior: number[];
  /** logPi[w][j][l] = safeLog(π^w[j][l]) */
  logPi: number[][][];
}

function buildLogTables(prior: readonly number[], pi: readonly (readonly (readonly number[])[])[]): LogTables {
  const logPrior = prior.map((p) => safeLog(p));
  const logPi = pi.map((m) => m.map((row) => row.map((x) => safeLog(x))));
  return { logPrior, logPi };
}

/**
 * E 步: γ_ij ∝ p_j·Π_w π^w[j][y^w_i]（log 域 + log-sum-exp；缺失标注跳过；
 * 1e-300 地板防 log(0)——R5: 查每轮构建的 log 表，算术序不变）
 */
function eStep(Y: readonly (readonly (number | null)[])[], tables: LogTables): number[][] {
  const W = Y.length;
  const I = Y[0]!.length;
  const C = tables.logPrior.length;
  const gamma = Array.from({ length: I }, () => new Array<number>(C).fill(0));
  for (let i = 0; i < I; i += 1) {
    const lp = new Array<number>(C);
    for (let j = 0; j < C; j += 1) {
      let acc = tables.logPrior[j]!;
      for (let w = 0; w < W; w += 1) {
        const v = Y[w]![i]!;
        if (v !== null) acc += tables.logPi[w]![j]![v];
      }
      lp[j] = acc;
    }
    let m = -Infinity;
    for (const x of lp) if (x > m) m = x;
    let sum = 0;
    for (let j = 0; j < C; j += 1) {
      lp[j] = Math.exp(lp[j]! - m);
      sum += lp[j]!;
    }
    for (let j = 0; j < C; j += 1) gamma[i]![j] = lp[j]! / sum;
  }
  return gamma;
}

/** M 步（混淆矩阵）: π^w_jl = (Σ_i γ_ij·1[y^w_i=l] + s)/(Σ_i γ_ij + s·C)，闭式极大化 */
function mStepConfusion(Y: readonly (readonly (number | null)[])[], gamma: readonly (readonly number[])[], s: number): number[][][] {
  const W = Y.length;
  const I = Y[0]!.length;
  const C = gamma[0]!.length;
  const pi = Array.from({ length: W }, () => Array.from({ length: C }, () => new Array<number>(C).fill(0)));
  for (let w = 0; w < W; w += 1) {
    for (let j = 0; j < C; j += 1) {
      const counts = new Array<number>(C).fill(s); // 伪计数平滑（防零单元）
      for (let i = 0; i < I; i += 1) {
        const v = Y[w]![i]!;
        if (v !== null) counts[v] += gamma[i]![j]!;
      }
      const denom = counts.reduce((a, b) => a + b, 0);
      for (let l = 0; l < C; l += 1) pi[w]![j]![l] = denom > 1e-12 ? counts[l]! / denom : 1 / C;
    }
  }
  return pi;
}

/** M 步（类别先验）: p_j = (Σ_i γ_ij + s)/(I + s·C) */
function mStepPrior(gamma: readonly (readonly number[])[], s: number): number[] {
  const I = gamma.length;
  const C = gamma[0]!.length;
  const counts = new Array<number>(C).fill(s);
  for (let i = 0; i < I; i += 1) for (let j = 0; j < C; j += 1) counts[j] += gamma[i]![j]!;
  const denom = counts.reduce((a, b) => a + b, 0);
  return counts.map((v) => v / denom);
}

/** 观测对数似然 LL(θ) = Σ_i log-sum-exp_j [log p_j + Σ_w log π^w_j,y]（R5: 查 log 表） */
function logLikelihood(Y: readonly (readonly (number | null)[])[], tables: LogTables): number {
  const W = Y.length;
  const I = Y[0]!.length;
  const C = tables.logPrior.length;
  let total = 0;
  for (let i = 0; i < I; i += 1) {
    const lp = new Array<number>(C);
    for (let j = 0; j < C; j += 1) {
      let acc = tables.logPrior[j]!;
      for (let w = 0; w < W; w += 1) {
        const v = Y[w]![i]!;
        if (v !== null) acc += tables.logPi[w]![j]![v];
      }
      lp[j] = acc;
    }
    let m = -Infinity;
    for (const x of lp) if (x > m) m = x;
    let sum = 0;
    for (const x of lp) sum += Math.exp(x - m);
    total += m + Math.log(sum);
  }
  return total;
}

// ─────────────────────────── 信任票权 ───────────────────────────

/**
 * 信任票权: reliability_w = Σ_j p_j·π^w[j][j]——先验加权的混淆矩阵对角质量。
 * 好 worker ≈ 其准确率；垃圾 worker ≈ 1/C；对抗者 ≈ 其对角（趋 0）。
 * 与 weightedMajority 串联即「按历史混淆矩阵加权的信任投票」。
 */
export function reliabilityWeights(
  confusions: readonly (readonly (readonly number[])[])[],
  classPrior: readonly number[],
): number[] {
  validateSimplex(classPrior, 'classPrior');
  const C = classPrior.length;
  if (!Array.isArray(confusions) || confusions.length === 0) throw new Error('reliabilityWeights: confusions 需要非空混淆矩阵表');
  for (let w = 0; w < confusions.length; w += 1) validateStochastic(confusions[w]!, C, `confusions[${w}]`);
  return confusions.map((m) => round(classPrior.reduce((acc, p, j) => acc + p * m[j]![j]!, 0)));
}

// ─────────────────────────── R5 进化: 已知混淆下的贝叶斯最优聚合 ───────────────────────────

/** bayesianAggregate 结果: 一步闭式后验（无 EM 迭代）*/
export interface BayesianAggregateResult {
  /** MAP 判决（后验 argmax，平票取小类号——与 majorityVote 同平票规则）*/
  estimatedLabels: number[];
  /** 真值后验 γ_ij（I × C，行和 1——对数域 log-sum-exp 归一，数值稳定）*/
  truthPosterior: number[][];
  /** 观测对数似然 Σ_i log-sum-exp_j[log p_j + Σ_w log π^w_j,y]（与 DS 的 LL 同口径）*/
  logLikelihood: number;
  /** 实际使用的类别先验（缺省均匀; 返回原值供审计）*/
  classPrior: number[];
  size: { workers: number; items: number; classes: number };
}

/**
 * 已知混淆矩阵的贝叶斯最优聚合（多数票的后验加权升级——R5 数学轴）。
 *
 * γ_ij ∝ p_j·Π_{w: y^w_i 非缺失} π^w[j][y^w_i]，判 argmax——这正是 DS
 * E 步的闭式，但参数取**已知**值（历史拟合/平台审计的混淆矩阵）而非
 * EM 重新估计: 零迭代一步出全部后验。生成模型正确时 MAP 判决最小化
 * 期望 0-1 损失（贝叶斯最优）; 对抗者被反演——P(报 j+1|真 j)=0.85 的
 * 循环反指行在似然里是强证据，反指者从「双倍作恶」变成「双倍信息」。
 *
 * 全程对数域（safeLog 1e-300 地板 + log-sum-exp）: W·C 连乘在线性域
 * W ≳ 100 / 极端混淆下必下溢为 0，对数域稳定。
 */
export function bayesianAggregate(
  labels: CrowdsourcedLabels,
  confusions: readonly (readonly (readonly number[])[])[],
  classPrior?: readonly number[],
): BayesianAggregateResult {
  const geo = checkLabels(labels);
  const C = geo.classes;
  if (!Array.isArray(confusions) || confusions.length !== geo.workers) {
    throw new Error(`bayesianAggregate: confusions 需要 ${geo.workers} 个混淆矩阵（收到 ${confusions?.length}）`);
  }
  for (let w = 0; w < confusions.length; w += 1) validateStochastic(confusions[w]!, C, `confusions[${w}]`);
  let prior: number[];
  if (classPrior === undefined) {
    prior = Array.from({ length: C }, () => 1 / C);
  } else {
    validateSimplex(classPrior, 'classPrior');
    if (classPrior.length !== C) {
      throw new Error(`bayesianAggregate: classPrior 长度 ${classPrior.length} ≠ classes ${C}`);
    }
    prior = [...classPrior];
  }
  const Y = labels.labels;
  const W = geo.workers;
  const I = geo.items;
  const tables = buildLogTables(prior, confusions);
  const truthPosterior = eStep(Y, tables);
  const estimatedLabels = truthPosterior.map((row) => argmaxTieSmallest(row));
  return {
    estimatedLabels,
    truthPosterior: truthPosterior.map((row) => row.map(round)),
    logLikelihood: round(logLikelihood(Y, tables)),
    classPrior: prior.map(round),
    size: { workers: W, items: I, classes: C },
  };
}

// ─────────────────────────── 众包仿真工厂 ───────────────────────────

/**
 * 众包标注仿真（混淆矩阵谱工厂）:
 *   good        近单位阵（对角缺省 0.9，余量均摊）——专家
 *   medium      中等（对角缺省 0.6）——普通评分者
 *   spammer     均匀（全 1/C）——无用者（给 diagonal 则对角 d 余量均摊）
 *   adversarial 循环反指（对角缺省 0.15，余量集中给 (j+1) mod C）——系统性别错
 *   random      随机坏人（mulberry32 行随机化；给 diagonal 则非对角随机分摊 1−d）
 * 显式 confusion 整体覆盖原型。truth ~ classPrior（缺省均匀），
 * 标注按各行混淆矩阵采样；coverage < 1 产生缺失（null）。
 * 确定性口径: 真值与每个 worker 各用独立子流（种子哈希分裂）——
 * 共用单流时 mulberry32 固定滞后的序列相关会污染「给定真值的投票
 * 条件分布」（把垃圾 worker 的经验行推离均匀），独立子流消除之。
 */
export function simulateCrowd(spec: CrowdSimulationSpec): SimulatedCrowd {
  if (!spec || !Array.isArray(spec.workers) || spec.workers.length === 0) {
    throw new Error('simulateCrowd: workers 需要非空规格表');
  }
  if (!Number.isInteger(spec.items) || spec.items < 1 || spec.items > 1000000) {
    throw new Error(`simulateCrowd: items 需要 1..1000000 的整数（收到 ${spec.items}）`);
  }
  if (spec.classes !== undefined && (!Number.isInteger(spec.classes) || spec.classes < 2)) {
    throw new Error(`simulateCrowd: classes 需要 ≥ 2 的整数（收到 ${spec.classes}）`);
  }
  const C = spec.classes ?? spec.classPrior?.length ?? 3;
  if (spec.classPrior !== undefined && spec.classPrior.length !== C) {
    throw new Error(`simulateCrowd: classPrior 长度 ${spec.classPrior.length} ≠ classes ${C}`);
  }
  const prior = spec.classPrior ? [...spec.classPrior] : Array.from({ length: C }, () => 1 / C);
  validateSimplex(prior, 'classPrior');

  const rng = mulberry32(spec.seed);
  // 抽取顺序固定（确定性）: 先全部混淆矩阵 → 真值（子流 0）→ 逐 worker 标注（子流 w+1）
  const confusions = spec.workers.map((w, idx) => buildConfusion(w, C, rng, `workers[${idx}]`));
  const truthRng = mulberry32(streamSeed(spec.seed, 0));
  const truth = Array.from({ length: spec.items }, () => categorical(truthRng, prior));
  const workers = spec.workers.map((_, w) => `w${w}`);
  const labels = spec.workers.map((wk, w) => {
    const cov = wk.coverage ?? 1;
    if (!Number.isFinite(cov) || cov < 0 || cov > 1) throw new Error(`simulateCrowd: coverage = ${cov} 非法（需要 [0,1]）`);
    const confusion = confusions[w]!;
    const wrng = mulberry32(streamSeed(spec.seed, w + 1));
    return Array.from({ length: spec.items }, (_, i) =>
      cov < 1 && wrng() >= cov ? null : categorical(wrng, confusion[truth[i]!]!),
    );
  });
  return {
    truth,
    labels: { workers, classes: C, labels },
    confusions,
    classPrior: prior,
    coverage: spec.workers.map((wk) => wk.coverage ?? 1),
  };
}

/** 由原型/覆盖生成单个 worker 的混淆矩阵（行随机） */
function buildConfusion(spec: CrowdWorkerSpec, C: number, rng: () => number, name: string): number[][] {
  if (spec.confusion) {
    validateStochastic(spec.confusion, C, `${name}.confusion`);
    return spec.confusion.map((row) => [...row]);
  }
  const kind = spec.archetype ?? WORKER_ARCHETYPES.random;
  const d = spec.diagonal;
  if (d !== undefined && (!Number.isFinite(d) || d < 0 || d > 1)) {
    throw new Error(`${name}.diagonal = ${d} 非法（需要 [0,1]）`);
  }
  switch (kind) {
    case WORKER_ARCHETYPES.good:
      return diagonalUniformMatrix(d ?? 0.9, C);
    case WORKER_ARCHETYPES.medium:
      return diagonalUniformMatrix(d ?? 0.6, C);
    case WORKER_ARCHETYPES.spammer:
      return d === undefined ? uniformMatrix(C) : diagonalUniformMatrix(d, C);
    case WORKER_ARCHETYPES.adversarial:
      return cyclicAdversarialMatrix(d ?? 0.15, C);
    case WORKER_ARCHETYPES.random:
      return randomStochasticMatrix(C, d, rng);
    default:
      throw new Error(`${name}: 未知 archetype "${String(kind)}"`);
  }
}

/** 对角 d、余量均摊（good/medium/spammer 带对角覆盖） */
function diagonalUniformMatrix(d: number, C: number): number[][] {
  return Array.from({ length: C }, (_, j) =>
    Array.from({ length: C }, (_, l) => (l === j ? d : (1 - d) / (C - 1))),
  );
}

/** 全 1/C（spammer: 与真值统计独立的无用者） */
function uniformMatrix(C: number): number[][] {
  return Array.from({ length: C }, () => Array.from({ length: C }, () => 1 / C));
}

/** 循环反指: 行 j 对角 d，(j+1) mod C 集中 1−d，其余 0（系统性把 j 报成 j+1） */
function cyclicAdversarialMatrix(d: number, C: number): number[][] {
  return Array.from({ length: C }, (_, j) =>
    Array.from({ length: C }, (_, l) => (l === j ? d : l === (j + 1) % C ? 1 - d : 0)),
  );
}

/** 随机坏人: 行随机化（d 给定时对角锁 d、余量随机分摊） */
function randomStochasticMatrix(C: number, d: number | undefined, rng: () => number): number[][] {
  return Array.from({ length: C }, (_, j) => {
    const raw = Array.from({ length: C }, () => rng());
    const row = new Array<number>(C).fill(0);
    if (d === undefined) {
      const total = raw.reduce((a, b) => a + b, 0);
      for (let l = 0; l < C; l += 1) row[l] = raw[l]! / total;
    } else {
      row[j] = d;
      let rest = 0;
      for (let l = 0; l < C; l += 1) if (l !== j) rest += raw[l]!;
      for (let l = 0; l < C; l += 1) if (l !== j) row[l] = rest > 0 ? ((1 - d) * raw[l]!) / rest : (1 - d) / (C - 1);
    }
    return row;
  });
}

// ─────────────────────────── 校验与工具 ───────────────────────────

/** 标注观测结构校验（显式 throw；返回几何） */
function checkLabels(labels: CrowdsourcedLabels): { workers: number; items: number; classes: number } {
  if (!labels || !Array.isArray(labels.workers) || labels.workers.length === 0) {
    throw new Error('checkLabels: workers 必须是非空 id 表');
  }
  for (const id of labels.workers) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('checkLabels: worker id 必须是非空字符串');
  }
  if (!Number.isInteger(labels.classes) || labels.classes < 2) {
    throw new Error(`checkLabels: classes 需要 ≥ 2 的整数（收到 ${labels.classes}）`);
  }
  if (!Array.isArray(labels.labels) || labels.labels.length !== labels.workers.length) {
    throw new Error(`checkLabels: labels 行数 ${labels.labels?.length} ≠ workers ${labels.workers.length}（矩阵必须 workers × items 对齐）`);
  }
  const items = labels.labels[0]!.length;
  if (!Number.isInteger(items) || items < 1) throw new Error(`checkLabels: item 数 ${items} 非法（需要 ≥ 1）`);
  for (let w = 0; w < labels.labels.length; w += 1) {
    const row = labels.labels[w]!;
    if (!Array.isArray(row) || row.length !== items) {
      throw new Error(`checkLabels: 第 ${w} 个 worker 的标注行长度 ${row?.length} ≠ ${items}（矩阵必须对齐）`);
    }
    for (let i = 0; i < items; i += 1) {
      const v = row[i]!;
      if (v === null) continue;
      if (!Number.isInteger(v) || v < 0 || v >= labels.classes) {
        throw new Error(`checkLabels: labels[${w}][${i}] = ${v} 越界（应为 null 或 0..${labels.classes - 1}）`);
      }
    }
  }
  for (let i = 0; i < items; i += 1) {
    let any = false;
    for (let w = 0; w < labels.labels.length && !any; w += 1) if (labels.labels[w]![i]! !== null) any = true;
    if (!any) throw new Error(`checkLabels: item ${i} 无任何标注（全缺失 → E 步无信息，拒绝而非静默给均匀后验）`);
  }
  return { workers: labels.workers.length, items, classes: labels.classes };
}

/** 概率单纯形校验（非负、和 1） */
function validateSimplex(p: readonly number[], name: string): void {
  if (!Array.isArray(p) || p.length < 1) throw new Error(`${name}: 需要非空概率向量`);
  let sum = 0;
  for (const x of p) {
    if (!Number.isFinite(x) || x < 0) throw new Error(`${name}: 含非法分量 ${x}（需要有限非负）`);
    sum += x;
  }
  if (Math.abs(sum - 1) > 1e-6) throw new Error(`${name}: 分量和 ${sum} ≠ 1（概率单纯形）`);
}

/** C×C 行随机矩阵校验（非负、行和 1；容差 1e-4 容纳六位小数圆整残差） */
function validateStochastic(m: readonly (readonly number[])[], C: number, name: string): void {
  if (!Array.isArray(m) || m.length !== C) throw new Error(`${name}: 需要 ${C}×${C} 方阵（收到 ${m?.length} 行）`);
  for (let j = 0; j < C; j += 1) {
    const row = m[j]!;
    if (!Array.isArray(row) || row.length !== C) throw new Error(`${name}: 第 ${j} 行长度 ${row?.length} ≠ ${C}`);
    let sum = 0;
    for (const x of row) {
      if (!Number.isFinite(x) || x < 0) throw new Error(`${name}[${j}] 含非法分量 ${x}（需要有限非负）`);
      sum += x;
    }
    if (Math.abs(sum - 1) > 1e-4) throw new Error(`${name}[${j}] 行和 ${sum} ≠ 1（行随机）`);
  }
}

/** argmax（平票取最小下标——确定性平票规则） */
function argmaxTieSmallest(scores: readonly number[]): number {
  let best = 0;
  for (let j = 1; j < scores.length; j += 1) if (scores[j]! > scores[best]!) best = j;
  return best;
}

/** 分类抽样（累积分布；行随机向量） */
function categorical(rng: () => number, probs: readonly number[]): number {
  const u = rng();
  let acc = 0;
  for (let j = 0; j < probs.length - 1; j += 1) {
    acc += probs[j]!;
    if (u < acc) return j;
  }
  return probs.length - 1;
}

/** log 地板（防 log(0)；smoothing=0 时的零单元不至于 −∞ 毁掉 LL） */
function safeLog(x: number): number {
  return Math.log(x > 1e-300 ? x : 1e-300);
}

/** 确定性 RNG（mulberry32；内核自备，不依赖 Math.random） */
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

/** 子流种子分裂: 种子与流号 k 双重哈希（不同 k 互相独立，同 seed+k 同流——确定性） */
function streamSeed(seed: number, k: number): number {
  return (Math.imul(seed ^ (k + 0x9e3779b9), 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0;
}

/** 六位小数圆整（项目统一展示口径；EM 内部迭代不圆整，保单调性与收敛精度） */
function round(x: number): number {
  return Number.isFinite(x) ? Number(x.toFixed(6)) : 0;
}

/* ── 接线建议 ──
 * 建议挂载引擎:
 *   1) 判断层多模型聚合——N 个模型对同一判定各自报标签时，现在人人
 *      一票；挂载后把投票记录喂 dawidSkene(labels)，truthPosterior
 *      作为聚合判定输出，workerReliability 作为该批次各模型的信任
 *      票权（哪个模型在哪类问题上可信，EM 从记录里自己学出来）；
 *   2) 轻量路径（不跑 EM 的热路径）——用滑动窗口积累的历史投票先验
 *      拟合一次混淆矩阵，运行时只调 weightedMajority(labels,
 *      reliabilityWeights(...))：信任投票一步出，EM 离线重估；
 *   3) 与 16.0 Shapley 串联——DS 学「谁在哪里可信」（喂聚合），
 *      Shapley 分「协作剩余怎么分账」（喂结算），两个口径可同源
 *      投票记录；
 *   4) 与 20.0 层论共识 / 81.0 对抗论证并联——82.0 先降权（垃圾/
 *      对抗者在 E 步自动出局），20.0 再对剩余分歧定位结构（哪条
 *      声明上不一致），81.0 审对抗动机：三种口径互补不互替。
 * 缺省关闭旗标: kernels.crowdAggregation.enabled（缺省 false——未
 *   挂载时聚合路径与既有等权投票逐位一致，本内核零介入）。
 * 挂载后改变的决策点:
 *   1) 多模型判定的聚合从「数手数」升级为「混淆矩阵加权的后验」；
 *   2) 模型可信度从静态配置升级为随投票记录在线重估的 π^w（对角
 *      塌陷 = 自动摘牌，无需人工规则）；
 *   3) 类别先验 p(z) 与少数类召回的权衡显式化（锚点⑤口径：先验
 *      不均衡时多数票的基数暴力被数学校正）。
 * 零漂移口径: 纯函数、同输入同输出、无 I/O 无时钟（随机仅仿真
 *   工厂内的 mulberry32(seed)）。
 */
