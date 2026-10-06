/**
 * 98.0 经验重放内核 —— experience replay：睡一觉想明白（优先重放 + 睡眠固化）
 *
 * 动机: 系统白天产出的每条经验（某臂/某动作得了多少回报）都蕴含策略信息，
 * 但在线学习是「来一条吃一条」的单遍流——两条结构性损失: ① 单遍流按到达
 * 顺序更新，高信息量转移（预测误差大的）和低信息量转移吃同样的学习率，
 * 样本效率低；② 流式任务切换（任务 A 用得熟了、任务 B 涌进来）会把 A
 * 的参数直接覆写——灾难性遗忘（catastrophic forgetting）: 新任务学得越
 * 快，旧任务忘得越干净。生物系统用两个机制对抗: 优先重放（海马体倾向
 * 重放「意外」事件）与睡眠固化（离线阶段不采新数据、只反刍历史经验）。
 * 本内核把这两个机制数学化: ① 分层优先经验重放缓冲区（PER）; ② 重要
 * 性采样权重修正优先采样的统计偏差; ③ 睡眠固化（只重放、不采新的可测
 * 离线进步）; ④ 排练（rehearsal）对照实验——流式 A→B 下无重放 A 性能
 * 崩塌、分层重放 A 保持（招牌断言）。
 *
 * 数学:
 *   ① 重放缓冲区（环形 + 分层防覆盖饥饿）: 每条转移带 task 层标签；
 *      第 k 个出现的任务层配额 quota(k) = floor(capacity/k)（≥1），
 *      层内 FIFO 环（超出配额覆盖本层最旧样本），新层出现时各旧层从
 *      最旧端收缩到新配额。总量 ≤ k·quota(k) ≤ capacity（守恒），且任
 *      一层的样本只能被同层样本覆盖——新任务的洪峰冲不掉旧任务的存活
 *      样本（分层公平; 单一全局环在 capacity 条新样本后把旧任务清零，
 *      这是两口径的分水岭）。层款式容量上限: 任务层数 > capacity 时配给
 *      失效，显式 throw（诚实边界）。
 *   ② 优先级采样（rank-based PER, Schaul et al. 2016）: 优先级 = |TD
 *      误差|，按 |TD| 降序排名 r_i（平局按入序稳定破并列），采样概率
 *        P(i) = r_i^(−α) / Σ_j r_j^(−α)
 *      α = 0 均匀、α = 1 全优先（温度 α 单调控制集中度）。rank 口径对
 *      |TD| 的重尾不敏感（proportional 口径会被单个巨误差垄断），且无
 *      需堆——分布由当前缓冲区内容整批重算（O(n log n)/次采样，数学
 *      内核规模 n ≤ 1e4 完全可行，文档化复杂度取舍）。
 *   ③ 重要性采样（IS）权重修正: 优先采样对分布做了非均匀扭曲，直接在
 *      采样集上做「平均」统计得到的是扭曲分布的期望。逐样本权重
 *        w_i = (1/(N·P_i))^β
 *      （β = 0 不修正、β = 1 完全修正；输出按 max 归一——对比率型
 *      估计量 Σw·x/Σw 归一化不改变期望）。在简单 bandit 上: 优先采样
 *      （偏向高 |TD| ⟹ 偏向高回报）的无修正逐臂均值系统性偏高于真值；
 *      w-加权均值收敛到真值（E[w·1(i)] = 1/N·Σ 1 = 无偏——锚点②）。
 *   ④ 睡眠固化（sleep consolidation）: 不加新环境数据，对缓冲区做 rounds
 *      轮「优先采样批 + IS 加权更新 + 新 |TD| 回写优先级」的离线改进。
 *      学习器为 Q 型 SGD（V(a) ← V(a)+lr·w·(r−V(a)), off-policy bandit
 *      口径）; 策略价值 = 真值表 truth[greedyArm(V̂)]。含未消化经验
 *      的缓冲区（数据说臂 1 好、学习器还以为臂 0 好）经睡眠后 greedy 臂
 *      翻正——离线、零新数据、可测提升（锚点③）。|TD| = |r − V̂(a)| 的
 *      优先级让「预测错得最离谱」的经验被重放得最多——消化最快的口径。
 *   ⑤ 排练抗遗忘（rehearsal）: 流式任务 A→B，共享动作价值表（任务 A
 *      好臂 0 / 任务 B 好臂 1 的矛盾结构）。无重放: B 阶段只吃 B 流，
 *      V → B 的真值 → A 上 greedy 臂翻错（性能跌 > 50%）。分层重放:
 *      B 阶段每条新样本配 replayPerFresh 条 A 层重放（层内优先采样 +
 *      IS 权重），V 收敛到 (replay·μ_A + fresh·μ_B)/(replay+fresh) 的
 *      凸组合——replayPerFresh = 2 时组合中心 ≈ (2·0.9+0.1)/3 = 0.63
 *      vs 0.37，greedy 臂保持 0，A 性能保持 ≥ 80%（锚点④，招牌断言）。
 *
 * 验证锚点（scripts/verify-metacognition-replay.mjs）:
 *   ① 高 |TD| 转移被采样频率显著高于均匀（|TD|-频率 Spearman > 0.95），
 *      top-20% 采样份额随 α ∈ {0, 0.5, 1} 严格递增（0.20 < 0.45 < 0.70
 *      量级），α = 0 时概率逐条精确相等 1/N；
 *   ② IS 权重（β = 1）修正后逐臂估值收敛到真值（|V̂−μ| ≤ 0.02），
 *      无修正对照系统性偏高于真值（偏置 > 0.2）；
 *   ③ 睡眠固化: 缓冲区长度不变（零新数据）、samplesUsed = rounds×batch，
 *      策略价值提升 ≥ 0.5（未消化经验被离线消化）；
 *   ④ 灾难遗忘对照: A→B 无重放 A 性能跌 > 50%；分层重放 A 保持 ≥ 80%
 *      （protected 双条件同时成立）；
 *   ⑤ 环形容量守恒（总量 ≤ capacity、饱和时 === capacity）与分层公平
 *      （600 条 A 洪峰后 1200 条 B 涌入，A 层仍存活 300 条——单一全局环
 *      已把 A 清零的对照口径）。
 *
 * 应用: 长期记忆/心跳循环——夜间批处理阶段把白天的经验离线消化成策略
 *   （「睡眠固化」成为自主循环的一个正式阶段）；分层缓冲挂记忆库分层
 *   配额（旧技能不被新洪峰覆盖）。
 *
 * ── 第五轮世界性进化（R5-A15，四轴）──
 * 1. [数学] 情景重放的分层重要性——TD × 新奇 × 年龄三因子：
 *      P(i) ∝ rank_td(i)^(−α) · (1 + replays_i)^(−ν) · (1 + age_i)^γ
 *    ν = noveltyDecay 压「重放垄断」（同一条高 |TD| 经验反复被抽，
 *    睡眠轮次间分布退化为单点——新奇因子让它让位）；γ = ageBoost
 *    抬老经验（对抗「新洪峰挤出旧技能」的采样侧老化）。ν = γ = 0
 *    （缺省）时两个因子恒为 1——与旧分布逐位相同（向后兼容锚点）。
 *    IS 权重 w = (1/(N·P_i))^β 对任意分布 P 都成立无偏修正——三因子
 *    开启后 β = 1 仍恢复 bandit 真值（锚点复检）。
 * 2. [性能] 全局分布 + CDF 缓存：rank 分布与累积数组在「优先级/成员
 *    未变」期间复用（push / updatePriorities / ν>0 的抽样会失效）。
 *    睡眠固化循环每轮 sample + iswWeights 两次求分布 → 一次；连续
 *    多批量采样从 O(N log N)/次 降到 O(log N)/次。缓存不改变任何
 *    数值路径（同 dist 同 cum 同 rng 消费）——输出逐位不变。
 * 3. [数值] 新奇/年龄因子走 log 域外 only.pow（参数域校验 ν,γ ≥ 0，
 *    (1+replays)、(1+age) 恒 ≥ 1 无下溢；权重归一 max 兜底 1e-300
 *    沿用）。
 * 4. [性质] 种子化批量断言：ν>0 时重放覆盖率（被抽过的样本比例）
 *    高于 ν=0（反垄断的覆盖收益）、单样本频率份额下降；γ>0 时老
 *    样本份额被抬升；缺省参数与旧实现采样序列逐位一致。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 确定性随机源（文件内自带） ───────────────────────────

/** mulberry32 —— 本内核唯一随机源（同 seed 同输出，零宿主依赖） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 转移与奖励任务 ───────────────────────────

/**
 * 一条重放转移（off-policy bandit 口径）: task = 分层标签，arm = 动作，
 * reward = 即时回报，tdError = 优先级素材 |TD 误差|（缺省 |reward|）。
 */
export interface ReplayTransition {
  task: string;
  arm: number;
  reward: number;
  tdError?: number;
}

interface StoredItem {
  transition: ReplayTransition;
  td: number;
  /** 被抽中重放的次数（新奇因子的原料；第五轮进化） */
  replays: number;
  /** 入库时的全局 push 步号（年龄 = 当前步号 − birthStep；第五轮进化） */
  birthStep: number;
}

/** 奖励模型（const 对象 + 类型，strip-types 兼容） */
export const REWARD_MODEL = {
  /** Bernoulli(μ_a)——0/1 回报（真值 μ ∈ [0,1]） */
  bernoulli: 'bernoulli',
  /** N(μ_a, noise²)——连续回报（锚点④用，|TD| 连续分层） */
  gaussian: 'gaussian',
} as const;

export type RewardModelKind = (typeof REWARD_MODEL)[keyof typeof REWARD_MODEL];

/** 真值解析已知的 bandit 任务（锚点的解析分母） */
export interface BanditTask {
  name: string;
  means: number[];
  numArms: number;
  rewardModel: RewardModelKind;
  noise: number;
  /** 采样一次臂回报（rng 由调用方传入——任务本身零状态、纯函数） */
  sampleReward(arm: number, rng: () => number): number;
}

export interface MakeBanditTaskOptions {
  name: string;
  /** 逐臂真值均值 μ_a */
  means: number[];
  /** 缺省 bernoulli；gaussian 需 noise > 0 */
  rewardModel?: RewardModelKind;
  noise?: number;
}

/** 工厂：真值解析已知的 bandit 任务 */
export function makeBanditTask(options: MakeBanditTaskOptions): BanditTask {
  if (options === null || typeof options !== 'object') throw new Error('makeBanditTask: 需要 options 对象');
  const { name, means } = options;
  if (typeof name !== 'string' || name.length === 0) throw new Error(`makeBanditTask: name 须为非空字符串（收到 ${String(name)}）`);
  if (!Array.isArray(means) || means.length === 0) throw new Error('makeBanditTask: means 须为非空数组');
  for (let i = 0; i < means.length; i += 1) {
    if (!Number.isFinite(means[i])) throw new Error(`makeBanditTask: means[${i}] 须为有限数（收到 ${means[i]}）`);
  }
  const rewardModel: RewardModelKind = options.rewardModel ?? REWARD_MODEL.bernoulli;
  const validModels: RewardModelKind[] = [REWARD_MODEL.bernoulli, REWARD_MODEL.gaussian];
  if (!validModels.includes(rewardModel)) {
    throw new Error(`makeBanditTask: rewardModel 须为 bernoulli/gaussian（收到 ${String(options.rewardModel)}）`);
  }
  const noise = options.noise ?? 0.1;
  if (!Number.isFinite(noise) || noise < 0) throw new Error(`makeBanditTask: noise 须为 ≥ 0 的有限数（收到 ${noise}）`);
  if (rewardModel === REWARD_MODEL.bernoulli) {
    for (let i = 0; i < means.length; i += 1) {
      if (means[i] < 0 || means[i] > 1) {
        throw new Error(`makeBanditTask: bernoulli 模式下 means[${i}] 须落在 [0,1]（收到 ${means[i]}）`);
      }
    }
  }
  return {
    name,
    means: [...means],
    numArms: means.length,
    rewardModel,
    noise,
    sampleReward(arm: number, rng: () => number): number {
      if (!Number.isInteger(arm) || arm < 0 || arm >= means.length) {
        throw new Error(`sampleReward: arm 须为 0..${means.length - 1} 的整数（收到 ${arm}）`);
      }
      if (rewardModel === REWARD_MODEL.bernoulli) {
        return rng() < means[arm] ? 1 : 0;
      }
      return means[arm] + noise * boxMullerFrom(rng);
    },
  };
}

/** 从任意 rng 现拉一对 Box–Muller（不缓存——sampleReward 是无状态纯函数） */
function boxMullerFrom(rng: () => number): number {
  let u = 0;
  do {
    u = rng();
  } while (u <= 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ─────────────────────────── ①②③ 分层优先重放缓冲区 ───────────────────────────

export interface PrioritizedReplayOptions {
  /** 总容量（整数 ≥ 2） */
  capacity: number;
  /** 优先级温度 α ∈ [0,1]（0 均匀 / 1 全优先；缺省 0.6） */
  alpha?: number;
  /** IS 修正指数 β ∈ [0,1]（缺省 0.4；无偏修正用 1） */
  beta?: number;
  /** 新奇因子指数 ν ≥ 0（缺省 0 = 关闭）：P 乘 (1+replays_i)^(−ν)——反「重放垄断」 */
  noveltyDecay?: number;
  /** 年龄因子指数 γ ≥ 0（缺省 0 = 关闭）：P 乘 (1+age_i)^γ——抬老经验（age = 入库以来的 push 步数） */
  ageBoost?: number;
  /** 随机种子（缺省 1） */
  seed?: number;
}

/** 一次采样的读出（indices 为 contents() 全局快照下标——两次 push 之间稳定） */
export interface ReplaySample {
  indices: number[];
  transitions: ReplayTransition[];
  /** 每个被采下标的采样概率（当前分布口径） */
  probabilities: number[];
}

/** IS 权重读出 */
export interface IswWeights {
  /** 归一化权重 w_i/max(w) ∈ (0,1]（比率型估计量对归一化不变） */
  weights: number[];
  /** 原始权重 (1/(N·P_i))^β */
  rawWeights: number[];
  beta: number;
}

/** 层式采样的读出（含层内分布对应的 IS 权重，β 由缓冲区配置） */
export interface LayerSample extends ReplaySample {
  isw: IswWeights;
}

interface Layer {
  task: string;
  ring: StoredItem[];
}

interface Distribution {
  probs: number[];
  total: number;
}

/**
 * ①②③ 分层优先经验重放缓冲区。
 *
 * - 分层环: 每个任务层独立 FIFO 环，配额 floor(capacity/层数)，防覆盖
 *   饥饿（锚点⑤）；
 * - rank-based 优先采样: P(i) ∝ rank(|TD|)^(−α)，α = 0 精确均匀（锚点①）；
 * - IS 权重: w = (1/(N·P))^β 归一化输出（锚点②）。
 *
 * 下标约定: sample()/sampleFromTask() 返回的 indices 对应 contents()
 * 快照（层按出现序、层内旧→新）——两次 push 之间下标稳定。
 */
export class PrioritizedReplay {
  private readonly capacityValue: number;
  private readonly alpha: number;
  private readonly betaValue: number;
  private readonly noveltyDecayValue: number;
  private readonly ageBoostValue: number;
  private readonly rng: () => number;
  private layers: Layer[] = [];
  private readonly layerIndex = new Map<string, Layer>();
  private flatDirty = true;
  private flat: StoredItem[] = [];
  /** 全局 push 步号（年龄因子的时钟） */
  private stepCounter = 0;
  /** 全局分布 + CDF 缓存（push / updatePriorities / ν>0 抽样后失效；第五轮进化） */
  private globalDist: { probs: number[]; cum: number[] } | null = null;

  constructor(options: PrioritizedReplayOptions) {
    if (options === null || typeof options !== 'object') {
      throw new Error('PrioritizedReplay: 需要 {capacity, alpha, beta, seed} options 对象');
    }
    const { capacity, alpha = 0.6, beta = 0.4, seed = 1 } = options;
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new Error(`PrioritizedReplay: capacity 须为 ≥2 的整数（收到 ${capacity}）`);
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new Error(`PrioritizedReplay: alpha 须落在 [0,1]（收到 ${alpha}）`);
    }
    if (!Number.isFinite(beta) || beta < 0 || beta > 1) {
      throw new Error(`PrioritizedReplay: beta 须落在 [0,1]（收到 ${beta}）`);
    }
    const noveltyDecay = options.noveltyDecay ?? 0;
    if (!Number.isFinite(noveltyDecay) || noveltyDecay < 0) {
      throw new Error(`PrioritizedReplay: noveltyDecay 须为 ≥ 0 的有限数（收到 ${options.noveltyDecay}）`);
    }
    const ageBoost = options.ageBoost ?? 0;
    if (!Number.isFinite(ageBoost) || ageBoost < 0) {
      throw new Error(`PrioritizedReplay: ageBoost 须为 ≥ 0 的有限数（收到 ${options.ageBoost}）`);
    }
    if (!Number.isFinite(seed) || seed < 0) {
      throw new Error(`PrioritizedReplay: seed 须为 ≥ 0 的数（收到 ${seed}）`);
    }
    this.capacityValue = capacity;
    this.alpha = alpha;
    this.betaValue = beta;
    this.noveltyDecayValue = noveltyDecay;
    this.ageBoostValue = ageBoost;
    this.rng = mulberry32(seed);
  }

  get capacity(): number {
    return this.capacityValue;
  }

  /** 当前层数配额 quota(k) = max(1, floor(capacity/k)) */
  private quota(): number {
    return Math.max(1, Math.floor(this.capacityValue / this.layers.length));
  }

  /** 推入一条转移（分层环: 超配额时覆盖本层最旧样本） */
  push(transition: ReplayTransition): void {
    if (transition === null || typeof transition !== 'object') {
      throw new Error('PrioritizedReplay.push: 需要 {task, arm, reward} 转移对象');
    }
    if (typeof transition.task !== 'string' || transition.task.length === 0) {
      throw new Error(`PrioritizedReplay.push: task 须为非空字符串（收到 ${String(transition.task)}）`);
    }
    if (!Number.isInteger(transition.arm) || transition.arm < 0) {
      throw new Error(`PrioritizedReplay.push: arm 须为 ≥ 0 的整数（收到 ${transition.arm}）`);
    }
    if (!Number.isFinite(transition.reward)) {
      throw new Error(`PrioritizedReplay.push: reward 须为有限数（收到 ${transition.reward}）`);
    }
    let td = transition.tdError;
    if (td !== undefined && (!Number.isFinite(td) || td < 0)) {
      throw new Error(`PrioritizedReplay.push: tdError 须为 ≥ 0 的有限数（收到 ${td}）`);
    }
    if (td === undefined) td = Math.abs(transition.reward); // 缺省: 奖励幅度作初始优先级
    let layer = this.layerIndex.get(transition.task);
    if (layer === undefined) {
      if (this.layers.length + 1 > this.capacityValue) {
        throw new Error(
          `PrioritizedReplay.push: 任务层数（${this.layers.length + 1}）超过容量（${this.capacityValue}）——分层配给失效（诚实边界）`,
        );
      }
      layer = { task: transition.task, ring: [] };
      this.layers.push(layer);
      this.layerIndex.set(transition.task, layer);
      // 新层出现: 各层收缩到新配额（从最旧端裁——总量守恒）
      const q = this.quota();
      for (const other of this.layers) {
        if (other.ring.length > q) other.ring.splice(0, other.ring.length - q);
      }
    }
    const q = this.quota();
    if (layer.ring.length >= q) layer.ring.shift(); // FIFO 覆盖本层最旧
    layer.ring.push({ transition: { ...transition }, td, replays: 0, birthStep: this.stepCounter });
    this.stepCounter += 1;
    this.flatDirty = true;
    this.globalDist = null; // 成员/年龄变化：全局分布缓存失效
  }

  size(): number {
    return this.contents().length;
  }

  /** 指定任务层的存活样本数 */
  sizeOf(task: string): number {
    const layer = this.layerIndex.get(task);
    return layer === undefined ? 0 : layer.ring.length;
  }

  /** 任务层清单（出现序） */
  tasks(): string[] {
    return this.layers.map((l) => l.task);
  }

  /** 只读快照（层按出现序、层内旧→新）——indices 的坐标基 */
  contents(): ReplayTransition[] {
    this.ensureFlat();
    return this.flat.map((item) => item.transition);
  }

  stats(): { size: number; capacity: number; alpha: number; beta: number; noveltyDecay: number; ageBoost: number; layers: Array<{ task: string; size: number; quota: number }> } {
    this.ensureFlat();
    const q = this.quota();
    return {
      size: this.flat.length,
      capacity: this.capacityValue,
      alpha: this.alpha,
      beta: this.betaValue,
      noveltyDecay: this.noveltyDecayValue,
      ageBoost: this.ageBoostValue,
      layers: this.layers.map((l) => ({ task: l.task, size: l.ring.length, quota: q })),
    };
  }

  /**
   * ② 优先采样（rank-based，有放回）。
   *
   * P(i) ∝ rank(|TD|)^(−α)，rank 按 |TD| 降序、平局按入序稳定破并列；
   * α = 0 时逐条概率精确 1/N（均匀）。第五轮进化：ν = noveltyDecay > 0
   * 或 γ = ageBoost > 0 时叠三因子 (1+replays)^(−ν)·(1+age)^γ（批量级
   * 快照——批内概率与实际抽样分布一致，IS 权重口径不破）。
   */
  sample(batchSize: number): ReplaySample {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(`PrioritizedReplay.sample: batchSize 须为 ≥1 的整数（收到 ${batchSize}）`);
    }
    this.ensureFlat();
    if (this.flat.length === 0) throw new Error('PrioritizedReplay.sample: 空缓冲区（先 push）');
    const g = this.ensureGlobalDist();
    return this.drawFromCum(g.probs, g.cum, batchSize);
  }

  /**
   * 分层采样: 指定任务层内 rank-based 优先采样（排练实验的旧任务层入口），
   * 附层内分布对应的 IS 权重（层内 N_layer 口径）。
   */
  sampleFromTask(task: string, batchSize: number): LayerSample {
    if (typeof task !== 'string' || task.length === 0) {
      throw new Error(`PrioritizedReplay.sampleFromTask: task 须为非空字符串（收到 ${task}）`);
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(`PrioritizedReplay.sampleFromTask: batchSize 须为 ≥1 的整数（收到 ${batchSize}）`);
    }
    const layer = this.layerIndex.get(task);
    if (layer === undefined) throw new Error(`PrioritizedReplay.sampleFromTask: 未知任务层 ${task}`);
    if (layer.ring.length === 0) throw new Error(`PrioritizedReplay.sampleFromTask: 任务层 ${task} 为空`);
    this.ensureFlat();
    const localIndices: number[] = [];
    for (let i = 0; i < this.flat.length; i += 1) {
      if (this.flat[i].transition.task === task) localIndices.push(i);
    }
    const dist = this.distributionOf(localIndices);
    const cum: number[] = new Array(dist.probs.length);
    let acc = 0;
    for (let i = 0; i < dist.probs.length; i += 1) {
      acc += dist.probs[i];
      cum[i] = acc;
    }
    const drawn = this.drawFromCum(dist.probs, cum, batchSize);
    return { ...drawn, isw: this.iswOf(dist, localIndices.length, drawn.indices, this.betaValue) };
  }

  /** 回写优先级（|TD 误差| 更新——重放后预测改进，优先级随之收缩） */
  updatePriorities(indices: ReadonlyArray<number>, tdErrors: ReadonlyArray<number>): void {
    if (!Array.isArray(indices) || !Array.isArray(tdErrors)) {
      throw new Error('PrioritizedReplay.updatePriorities: 需要 indices/tdErrors 数组');
    }
    if (indices.length !== tdErrors.length) {
      throw new Error(`updatePriorities: indices 长度（${indices.length}）须等于 tdErrors 长度（${tdErrors.length}）`);
    }
    this.ensureFlat();
    for (let k = 0; k < indices.length; k += 1) {
      const i = indices[k];
      if (!Number.isInteger(i) || i < 0 || i >= this.flat.length) {
        throw new Error(`updatePriorities: indices[${k}]=${String(i)} 越界 [0,${this.flat.length})`);
      }
      if (!Number.isFinite(tdErrors[k]) || tdErrors[k] < 0) {
        throw new Error(`updatePriorities: tdErrors[${k}] 须为 ≥ 0 的有限数（收到 ${tdErrors[k]}）`);
      }
      this.flat[i].td = tdErrors[k];
    }
    this.globalDist = null; // 优先级变化：全局分布缓存失效
  }

  /**
   * ③ IS 权重: w_i = (1/(N·P_i))^β，按 max 归一。
   *
   * P_i 取当前全局分布（缓存复用——与 sample() 同一份）；β 可覆写
   * （无偏修正实验用 β = 1）。第五轮进化：ν > 0 时采样分布随重放计数
   * 漂移——sample() 返回的 probabilities 是**抽样时刻的批量快照**，
   * 正确的 IS 修正须用同一快照：可选第三参 probabilities（与 indices
   * 对齐，直接来自 ReplaySample.probabilities）；缺省（ν = 0 时分布
   * 不变）用当前全局分布——与旧行为逐位一致。
   */
  iswWeights(indices: ReadonlyArray<number>, betaOverride?: number, probabilities?: ReadonlyArray<number>): IswWeights {
    if (!Array.isArray(indices)) throw new Error('PrioritizedReplay.iswWeights: 需要 indices 数组');
    const beta = betaOverride ?? this.betaValue;
    if (!Number.isFinite(beta) || beta < 0 || beta > 1) {
      throw new Error(`iswWeights: beta 须落在 [0,1]（收到 ${beta}）`);
    }
    this.ensureFlat();
    if (this.flat.length === 0) throw new Error('PrioritizedReplay.iswWeights: 空缓冲区');
    if (probabilities !== undefined) {
      if (!Array.isArray(probabilities) || probabilities.length !== indices.length) {
        throw new Error(`iswWeights: probabilities 长度（${probabilities?.length}）须与 indices（${indices.length}）对齐（传 ReplaySample.probabilities）`);
      }
      // indices[k] ↔ probabilities[k] 对齐 → 转成 buffer 下标口径（iswOf 按全长度数组取值）
      const probsByIndex = new Array<number>(this.flat.length).fill(0);
      for (let k = 0; k < indices.length; k += 1) {
        const pk = probabilities[k];
        if (typeof pk !== 'number' || !Number.isFinite(pk) || pk < 0) {
          throw new Error(`iswWeights: probabilities[${k}] 须为非负有限数（收到 ${String(pk)}）`);
        }
        probsByIndex[indices[k]!] = pk;
      }
      return this.iswOf({ probs: probsByIndex, total: 1 }, this.flat.length, [...indices], beta);
    }
    const g = this.ensureGlobalDist();
    return this.iswOf({ probs: g.probs, total: 1 }, this.flat.length, [...indices], beta);
  }

  // ── 内部 ──

  private ensureFlat(): void {
    if (!this.flatDirty) return;
    const flat: StoredItem[] = [];
    for (const layer of this.layers) {
      for (const item of layer.ring) flat.push(item);
    }
    this.flat = flat;
    this.flatDirty = false;
  }

  /** 全局 rank 分布 + CDF 缓存（第五轮进化：优先级/成员不变期间 O(1) 复用） */
  private ensureGlobalDist(): { probs: number[]; cum: number[] } {
    if (this.globalDist === null) {
      const dist = this.distributionOf(this.flat.map((_, i) => i));
      const cum: number[] = new Array(dist.probs.length);
      let acc = 0;
      for (let i = 0; i < dist.probs.length; i += 1) {
        acc += dist.probs[i];
        cum[i] = acc;
      }
      this.globalDist = { probs: dist.probs, cum };
    }
    return this.globalDist;
  }

  /** 三因子复合权重: rank_td^(−α) · (1+replays)^(−ν) · (1+age)^γ（ν=γ=0 时恒等原值——位级兼容） */
  private compositeWeight(rankWeight: number, item: StoredItem): number {
    if (this.noveltyDecayValue === 0 && this.ageBoostValue === 0) return rankWeight;
    let w = rankWeight;
    if (this.noveltyDecayValue > 0) w *= Math.pow(1 + item.replays, -this.noveltyDecayValue);
    if (this.ageBoostValue > 0) w *= Math.pow(1 + (this.stepCounter - item.birthStep), this.ageBoostValue);
    return w;
  }

  /** 给定全局下标集合上的 rank-based 分布（|TD| 降序，平局按入序；叠三因子） */
  private distributionOf(indices: ReadonlyArray<number>): Distribution {
    const ordered = [...indices].sort((a, b) => {
      const ta = this.flat[a].td;
      const tb = this.flat[b].td;
      if (tb !== ta) return tb - ta;
      return a - b;
    });
    const probs = new Array<number>(this.flat.length).fill(0);
    let total = 0;
    for (let rank = 0; rank < ordered.length; rank += 1) {
      const w = this.compositeWeight(Math.pow(rank + 1, -this.alpha), this.flat[ordered[rank]]);
      probs[ordered[rank]] = w;
      total += w;
    }
    for (let i = 0; i < probs.length; i += 1) probs[i] /= total;
    return { probs, total: 1 };
  }

  /** 从（分布, CDF）有放回抽取（逆 CDF + 二分——确定性）；登记重放计数，ν>0 时失效缓存 */
  private drawFromCum(probs: number[], cum: number[], batchSize: number): ReplaySample {
    const total = cum.length > 0 ? cum[cum.length - 1] : 0;
    const indices: number[] = [];
    const probabilities: number[] = [];
    for (let k = 0; k < batchSize; k += 1) {
      const u = this.rng() * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      indices.push(lo);
      probabilities.push(probs[lo]);
      this.flat[lo].replays += 1; // 新奇因子原料：登记被抽中
    }
    if (this.noveltyDecayValue > 0) this.globalDist = null; // 重放计数变了分布才变
    return { indices, transitions: indices.map((i) => this.flat[i].transition), probabilities };
  }

  private iswOf(dist: Distribution, populationSize: number, indices: ReadonlyArray<number>, beta: number): IswWeights {
    const raw = indices.map((i) => {
      const p = dist.probs[i];
      return p <= 0 ? 0 : Math.pow(1 / (populationSize * p), beta);
    });
    const max = raw.length === 0 ? 1 : Math.max(...raw, 1e-300);
    return { weights: raw.map((w) => w / max), rawWeights: raw, beta };
  }
}

// ─────────────────────────── ④ 学习器与睡眠固化 ───────────────────────────

/** 加权学习样本（重放更新口径） */
export interface WeightedSample {
  arm: number;
  reward: number;
  weight: number;
}

/**
 * 逐臂加权均值学习器（off-policy bandit 口径）。
 *
 * V(a) = Σw·r / Σw（增量精确、无学习率超参）；Σw = 0 时取初始值。
 * 比率型估计量对 IS 权重的整体缩放不变——max 归一化的 PER 权重直接可用。
 */
export class WeightedBanditLearner {
  private readonly init: number[];
  private readonly wSums: number[];
  private readonly wrSums: number[];

  constructor(numArms: number, initialValues?: number[]) {
    if (!Number.isInteger(numArms) || numArms < 1) {
      throw new Error(`WeightedBanditLearner: numArms 须为 ≥1 的整数（收到 ${numArms}）`);
    }
    if (initialValues !== undefined) {
      if (!Array.isArray(initialValues) || initialValues.length !== numArms) {
        throw new Error(`WeightedBanditLearner: initialValues 长度须等于 numArms=${numArms}`);
      }
      for (let i = 0; i < initialValues.length; i += 1) {
        if (!Number.isFinite(initialValues[i])) {
          throw new Error(`WeightedBanditLearner: initialValues[${i}] 须为有限数（收到 ${initialValues[i]}）`);
        }
      }
    }
    this.init = initialValues === undefined ? Array.from({ length: numArms }, () => 0) : [...initialValues];
    this.wSums = Array.from({ length: numArms }, () => 0);
    this.wrSums = Array.from({ length: numArms }, () => 0);
  }

  update(sample: WeightedSample): void {
    if (sample === null || typeof sample !== 'object') throw new Error('WeightedBanditLearner.update: 需要 {arm, reward, weight} 样本');
    if (!Number.isInteger(sample.arm) || sample.arm < 0 || sample.arm >= this.init.length) {
      throw new Error(`WeightedBanditLearner.update: arm 须为 0..${this.init.length - 1} 的整数（收到 ${sample.arm}）`);
    }
    if (!Number.isFinite(sample.reward)) throw new Error(`WeightedBanditLearner.update: reward 须为有限数（收到 ${sample.reward}）`);
    if (!Number.isFinite(sample.weight) || sample.weight <= 0) {
      throw new Error(`WeightedBanditLearner.update: weight 须为 > 0 的有限数（收到 ${sample.weight}）`);
    }
    this.wSums[sample.arm] += sample.weight;
    this.wrSums[sample.arm] += sample.weight * sample.reward;
  }

  valueOf(arm: number): number {
    if (!Number.isInteger(arm) || arm < 0 || arm >= this.init.length) {
      throw new Error(`WeightedBanditLearner.valueOf: arm 须为 0..${this.init.length - 1} 的整数（收到 ${arm}）`);
    }
    return this.wSums[arm] === 0 ? this.init[arm] : this.wrSums[arm] / this.wSums[arm];
  }

  greedyArm(): number {
    let best = 0;
    for (let a = 1; a < this.init.length; a += 1) {
      if (this.valueOf(a) > this.valueOf(best) + 1e-15) best = a;
    }
    return best;
  }

  /** 各臂累计权重（诊断: 消化了多少经验） */
  weightUsed(arm: number): number {
    if (!Number.isInteger(arm) || arm < 0 || arm >= this.init.length) {
      throw new Error(`WeightedBanditLearner.weightUsed: arm 须为 0..${this.init.length - 1} 的整数（收到 ${arm}）`);
    }
    return this.wSums[arm];
  }
}

/**
 * Q 型 SGD 学习器（固定步长）: V(a) ← V(a) + lr·w·(r − V(a))。
 *
 * 与加权均值学习器的本质差别: 常数 lr 下旧样本影响按 (1−lr)^k 几何衰减
 * ——**新数据覆写旧估值**，这是灾难遗忘现象的学习模型（锚点④的「遗忘
 * 来自参数覆写」）。混合流下的不动点是各来源均值的凸组合
 * V* = Σ_src λ_src·μ_src（λ = 该来源的有效更新份额），排练机制正是靠
 * 调节 λ（重放配比）把不动点锚在旧任务最优点一侧。w ≤ 1（IS 归一权重）
 * 只缩放步长、不动点不变。
 */
export class SgdBanditLearner {
  private readonly lrValue: number;
  private values: number[];

  constructor(numArms: number, options: { lr?: number; initialValues?: number[] } = {}) {
    if (!Number.isInteger(numArms) || numArms < 1) {
      throw new Error(`SgdBanditLearner: numArms 须为 ≥1 的整数（收到 ${numArms}）`);
    }
    if (options === null || typeof options !== 'object') {
      throw new Error('SgdBanditLearner: 需要 options 对象');
    }
    const lr = options.lr ?? 0.05;
    if (!Number.isFinite(lr) || lr <= 0 || lr > 1) {
      throw new Error(`SgdBanditLearner: lr 须落在 (0,1]（收到 ${lr}）`);
    }
    if (options.initialValues !== undefined) {
      if (!Array.isArray(options.initialValues) || options.initialValues.length !== numArms) {
        throw new Error(`SgdBanditLearner: initialValues 长度须等于 numArms=${numArms}`);
      }
      for (let i = 0; i < options.initialValues.length; i += 1) {
        if (!Number.isFinite(options.initialValues[i])) {
          throw new Error(`SgdBanditLearner: initialValues[${i}] 须为有限数（收到 ${options.initialValues[i]}）`);
        }
      }
    }
    this.lrValue = lr;
    this.values =
      options.initialValues === undefined ? Array.from({ length: numArms }, () => 0) : [...options.initialValues];
  }

  update(sample: WeightedSample): void {
    if (sample === null || typeof sample !== 'object') throw new Error('SgdBanditLearner.update: 需要 {arm, reward, weight} 样本');
    if (!Number.isInteger(sample.arm) || sample.arm < 0 || sample.arm >= this.values.length) {
      throw new Error(`SgdBanditLearner.update: arm 须为 0..${this.values.length - 1} 的整数（收到 ${sample.arm}）`);
    }
    if (!Number.isFinite(sample.reward)) throw new Error(`SgdBanditLearner.update: reward 须为有限数（收到 ${sample.reward}）`);
    if (!Number.isFinite(sample.weight) || sample.weight <= 0) {
      throw new Error(`SgdBanditLearner.update: weight 须为 > 0 的有限数（收到 ${sample.weight}）`);
    }
    this.values[sample.arm] += this.lrValue * Math.min(1, sample.weight) * (sample.reward - this.values[sample.arm]);
  }

  valueOf(arm: number): number {
    if (!Number.isInteger(arm) || arm < 0 || arm >= this.values.length) {
      throw new Error(`SgdBanditLearner.valueOf: arm 须为 0..${this.values.length - 1} 的整数（收到 ${arm}）`);
    }
    return this.values[arm];
  }

  greedyArm(): number {
    let best = 0;
    for (let a = 1; a < this.values.length; a += 1) {
      if (this.valueOf(a) > this.valueOf(best) + 1e-15) best = a;
    }
    return best;
  }

  valuesView(): number[] {
    return [...this.values];
  }
}

function assertReplayLike(buffer: unknown, who: string): void {
  if (buffer === null || typeof buffer !== 'object') {
    throw new Error(`${who}: buffer 须为 PrioritizedReplay 实例`);
  }
  const rec = buffer as Record<string, unknown>;
  for (const method of ['push', 'sample', 'sampleFromTask', 'updatePriorities', 'iswWeights', 'size', 'contents']) {
    if (typeof rec[method] !== 'function') {
      throw new Error(`${who}: buffer 缺少 ${method} 方法（须为 PrioritizedReplay 实例）`);
    }
  }
}

function assertLearnerLike(learner: unknown, who: string): void {
  if (learner === null || typeof learner !== 'object') {
    throw new Error(`${who}: learner 须为 WeightedBanditLearner 实例`);
  }
  const rec = learner as Record<string, unknown>;
  for (const method of ['update', 'valueOf', 'greedyArm']) {
    if (typeof rec[method] !== 'function') {
      throw new Error(`${who}: learner 缺少 ${method} 方法（须为 WeightedBanditLearner 实例）`);
    }
  }
}

export interface SleepConsolidationOptions {
  buffer: PrioritizedReplay;
  learner: WeightedBanditLearner;
  /** 逐臂真值（策略价值的解析测量: truth[greedyArm(V̂)]） */
  truth: number[];
  /** 固化轮数（整数 ≥ 1） */
  rounds: number;
  /** 每轮批量（缺省 32） */
  batchSize?: number;
  /** IS 修正指数（缺省 1——睡眠时全修正，统计口径优先于方差） */
  beta?: number;
  /** 是否用新 |TD| 回写优先级（缺省 true——预测改进后优先级收缩） */
  recomputePriorities?: boolean;
}

export interface SleepResult {
  /** 策略价值提升 truth[greedy]_after − before */
  improvement: number;
  policyValueBefore: number;
  policyValueAfter: number;
  /** 消耗的重放样本数 = rounds × batchSize（零新数据） */
  samplesUsed: number;
  rounds: number;
  batchSize: number;
  bufferSizeBefore: number;
  bufferSizeAfter: number;
  freshTransitions: 0;
}

/**
 * ④ 睡眠固化: 不加新环境数据，只重放历史经验的离线批量改进。
 *
 * 每轮: 优先采样批 → IS 加权逐样本更新 V(a) → 新 |TD| = |r − V̂(a)|
 * 回写优先级（消化过的经验自动降权）。策略价值用真值表测量
 * truth[greedyArm]——「未消化经验」缓冲区（数据与学习器当前认知相矛盾）
 * 经睡眠后 greedy 臂翻正，改善可测（锚点③）。函数保证 buffer 长度不变。
 */
export function sleepConsolidation(options: SleepConsolidationOptions): SleepResult {
  if (options === null || typeof options !== 'object') {
    throw new Error('sleepConsolidation: 需要 {buffer, learner, truth, rounds} options 对象');
  }
  assertReplayLike(options.buffer, 'sleepConsolidation');
  assertLearnerLike(options.learner, 'sleepConsolidation');
  if (!Array.isArray(options.truth) || options.truth.length === 0) {
    throw new Error('sleepConsolidation: truth 须为非空数组（逐臂真值）');
  }
  for (let i = 0; i < options.truth.length; i += 1) {
    if (!Number.isFinite(options.truth[i])) throw new Error(`sleepConsolidation: truth[${i}] 须为有限数`);
  }
  if (!Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error(`sleepConsolidation: rounds 须为 ≥1 的整数（收到 ${options.rounds}）`);
  }
  const batchSize = options.batchSize ?? 32;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`sleepConsolidation: batchSize 须为 ≥1 的整数（收到 ${batchSize}）`);
  }
  const beta = options.beta ?? 1;
  if (!Number.isFinite(beta) || beta < 0 || beta > 1) {
    throw new Error(`sleepConsolidation: beta 须落在 [0,1]（收到 ${beta}）`);
  }
  const valueOfGreedy = (): number => {
    const arm = options.learner.greedyArm();
    if (arm >= options.truth.length) {
      throw new Error(`sleepConsolidation: greedy 臂 ${arm} 超出 truth 范围（0..${options.truth.length - 1}）`);
    }
    return options.truth[arm];
  };
  const bufferSizeBefore = options.buffer.size();
  if (bufferSizeBefore === 0) throw new Error('sleepConsolidation: 空缓冲区（无经验可固化）');
  const policyValueBefore = valueOfGreedy();
  const recompute = options.recomputePriorities !== false;
  for (let r = 0; r < options.rounds; r += 1) {
    const batch = options.buffer.sample(batchSize);
    // IS 权重用抽样时刻的批量快照（ν>0 时分布随重放计数漂移——快照才是真实抽样分布）
    const isw = options.buffer.iswWeights(batch.indices, beta, batch.probabilities);
    for (let k = 0; k < batch.indices.length; k += 1) {
      const t = batch.transitions[k];
      options.learner.update({ arm: t.arm, reward: t.reward, weight: isw.weights[k] });
    }
    if (recompute) {
      options.buffer.updatePriorities(
        batch.indices,
        batch.transitions.map((t) => Math.abs(t.reward - options.learner.valueOf(t.arm))),
      );
    }
  }
  const policyValueAfter = valueOfGreedy();
  return {
    improvement: policyValueAfter - policyValueBefore,
    policyValueBefore,
    policyValueAfter,
    samplesUsed: options.rounds * batchSize,
    rounds: options.rounds,
    batchSize,
    bufferSizeBefore,
    bufferSizeAfter: options.buffer.size(),
    freshTransitions: 0,
  };
}

// ─────────────────────────── ⑤ 流式任务与排练对照 ───────────────────────────

export interface ContinualTaskStreamOptions {
  taskA: BanditTask;
  taskB: BanditTask;
  /** A 阶段样本数（缺省 300） */
  phaseASize?: number;
  /** B 阶段样本数（缺省 300） */
  phaseBSize?: number;
  /** 随机种子（缺省 7） */
  seed?: number;
}

export interface ContinualTaskStream {
  taskA: BanditTask;
  taskB: BanditTask;
  /** 任务 A 时期的均匀探索转移流 */
  phaseA: ReplayTransition[];
  /** 任务 B 时期涌进来的转移流 */
  phaseB: ReplayTransition[];
}

/**
 * ⑤ 工厂: 两个 bandit 任务先后到来的流式经验。
 *
 * 探索策略为均匀（部署期记录的通用探索口径）；奖励由任务真值模型种子化
 * 采样；初始 |TD| = |r − 0.5|（相对无信息基准的预测误差——排练阶段优先
 * 级冻结，锚点④的重放均匀性不依赖 α）。
 */
export function continualTaskStream(options: ContinualTaskStreamOptions): ContinualTaskStream {
  if (options === null || typeof options !== 'object') {
    throw new Error('continualTaskStream: 需要 {taskA, taskB, seed} options 对象');
  }
  const { taskA, taskB } = options;
  if (taskA === null || typeof taskA !== 'object' || typeof taskA.sampleReward !== 'function') {
    throw new Error('continualTaskStream: taskA 须为 BanditTask（makeBanditTask 工厂产出）');
  }
  if (taskB === null || typeof taskB !== 'object' || typeof taskB.sampleReward !== 'function') {
    throw new Error('continualTaskStream: taskB 须为 BanditTask（makeBanditTask 工厂产出）');
  }
  if (taskA.means.length !== taskB.means.length) {
    throw new Error(
      `continualTaskStream: 两任务须共享动作空间（taskA ${taskA.means.length} 臂 ≠ taskB ${taskB.means.length} 臂）`,
    );
  }
  const phaseASize = options.phaseASize ?? 300;
  const phaseBSize = options.phaseBSize ?? 300;
  if (!Number.isInteger(phaseASize) || phaseASize < 1) {
    throw new Error(`continualTaskStream: phaseASize 须为 ≥1 的整数（收到 ${phaseASize}）`);
  }
  if (!Number.isInteger(phaseBSize) || phaseBSize < 1) {
    throw new Error(`continualTaskStream: phaseBSize 须为 ≥1 的整数（收到 ${phaseBSize}）`);
  }
  const seed = options.seed ?? 7;
  if (!Number.isFinite(seed) || seed < 0) throw new Error(`continualTaskStream: seed 须为 ≥ 0 的数（收到 ${seed}）`);
  const rng = mulberry32(seed);
  const generate = (task: BanditTask, count: number): ReplayTransition[] => {
    const out: ReplayTransition[] = [];
    for (let i = 0; i < count; i += 1) {
      const arm = Math.floor(rng() * task.numArms) % task.numArms;
      const reward = task.sampleReward(arm, rng);
      out.push({ task: task.name, arm, reward, tdError: Math.abs(reward - 0.5) });
    }
    return out;
  };
  return {
    taskA,
    taskB,
    phaseA: generate(taskA, phaseASize),
    phaseB: generate(taskB, phaseBSize),
  };
}

export interface RehearsalOptions {
  taskA: BanditTask;
  taskB: BanditTask;
  seed?: number;
  phaseASize?: number;
  phaseBSize?: number;
  /** 每条 B 新样本配多少条 A 层重放（缺省 2；0 退化为无重放） */
  replayPerFresh?: number;
  /** 重放缓冲区容量（缺省 2×(phaseA+phaseB)，保证 A 层不被挤出） */
  capacity?: number;
  alpha?: number;
  beta?: number;
}

export interface RehearsalArmResult {
  /** A 阶段结束时任务 A 上的策略真值 μ_A[greedy] */
  aPerformanceBefore: number;
  /** B 阶段结束后任务 A 上的策略真值 */
  aPerformanceAfter: number;
  /** after / before（≥ 1 表示 A 性能未被侵蚀） */
  retention: number;
  /** 1 − after/before（无重放口径的灾难遗忘幅度） */
  dropFraction: number;
  greedyArmBefore: number;
  greedyArmAfter: number;
  /** 结束时的逐臂估值（诊断） */
  valueEstimates: number[];
}

export interface RehearsalReport {
  withoutReplay: RehearsalArmResult;
  withReplay: RehearsalArmResult;
  /** 招牌判据: 无重放跌 > 50% 且分层重放保持 ≥ 80% */
  protectedByRehearsal: boolean;
  stream: ContinualTaskStream;
}

function measureArm(task: BanditTask, learner: SgdBanditLearner): { value: number; greedy: number } {
  const greedy = learner.greedyArm();
  if (greedy >= task.means.length) {
    throw new Error(`rehearsalVsNone: greedy 臂 ${greedy} 超出任务真值范围`);
  }
  return { value: task.means[greedy], greedy };
}

/**
 * ⑤ 排练对照实验 runner（灾难遗忘 vs 分层重放）。
 *
 * 共享动作价值表（任务 A 好臂 0、任务 B 好臂 1 的矛盾结构——遗忘来自
 * 参数覆写而非数据缺失）。两条实验臂吃同一条种子化经验流:
 * - withoutReplay: A 流 → B 流，纯单遍在线学习；
 * - withReplay: A 流同时进分层缓冲；B 阶段每条新样本配 replayPerFresh 条
 *   A 层优先重放（层内 IS 加权）——V 收敛到新旧经验的凸组合。
 */
export function rehearsalVsNone(options: RehearsalOptions): RehearsalReport {
  if (options === null || typeof options !== 'object') {
    throw new Error('rehearsalVsNone: 需要 {taskA, taskB, seed} options 对象');
  }
  const { taskA, taskB } = options;
  if (taskA === null || typeof taskA.sampleReward !== 'function' || taskB === null || typeof taskB.sampleReward !== 'function') {
    throw new Error('rehearsalVsNone: taskA/taskB 须为 BanditTask（makeBanditTask 工厂产出）');
  }
  if (taskA.means.length !== taskB.means.length) {
    throw new Error(`rehearsalVsNone: 两任务须共享动作空间（${taskA.means.length} ≠ ${taskB.means.length}）`);
  }
  const seed = options.seed ?? 7;
  const replayPerFresh = options.replayPerFresh ?? 2;
  if (!Number.isInteger(replayPerFresh) || replayPerFresh < 0) {
    throw new Error(`rehearsalVsNone: replayPerFresh 须为 ≥ 0 的整数（收到 ${replayPerFresh}）`);
  }
  const alpha = options.alpha ?? 0.6;
  const beta = options.beta ?? 1;
  const stream = continualTaskStream({ taskA, taskB, seed, phaseASize: options.phaseASize, phaseBSize: options.phaseBSize });
  const numArms = taskA.means.length;

  // 对照臂: 无重放（A 学好 → B 洪峰覆写——常数 lr 的 SGD 会遗忘）
  const naive = new SgdBanditLearner(numArms, { lr: 0.05 });
  for (const t of stream.phaseA) naive.update({ arm: t.arm, reward: t.reward, weight: 1 });
  const beforeNaive = measureArm(taskA, naive);
  for (const t of stream.phaseB) naive.update({ arm: t.arm, reward: t.reward, weight: 1 });
  const afterNaive = measureArm(taskA, naive);

  // 实验臂: 分层重放排练
  const capacity = options.capacity ?? 2 * (stream.phaseA.length + stream.phaseB.length);
  const buffer = new PrioritizedReplay({ capacity, alpha, beta, seed: (seed * 2 + 1) >>> 0 });
  const rehearsal = new SgdBanditLearner(numArms, { lr: 0.05 });
  for (const t of stream.phaseA) {
    buffer.push(t);
    rehearsal.update({ arm: t.arm, reward: t.reward, weight: 1 });
  }
  const beforeRehearsal = measureArm(taskA, rehearsal);
  for (const t of stream.phaseB) {
    buffer.push(t); // B 层同步登记（分层: 挤不掉 A 层）
    rehearsal.update({ arm: t.arm, reward: t.reward, weight: 1 });
    if (replayPerFresh > 0) {
      const replay = buffer.sampleFromTask(taskA.name, replayPerFresh);
      for (let k = 0; k < replay.indices.length; k += 1) {
        const rt = replay.transitions[k];
        rehearsal.update({ arm: rt.arm, reward: rt.reward, weight: replay.isw.weights[k] });
      }
    }
  }
  const afterRehearsal = measureArm(taskA, rehearsal);

  const makeResult = (before: { value: number; greedy: number }, after: { value: number; greedy: number }, values: number[]): RehearsalArmResult => {
    const retention = before.value > 0 ? after.value / before.value : 1;
    return {
      aPerformanceBefore: before.value,
      aPerformanceAfter: after.value,
      retention,
      dropFraction: 1 - retention,
      greedyArmBefore: before.greedy,
      greedyArmAfter: after.greedy,
      valueEstimates: values,
    };
  };
  const withoutReplay = makeResult(
    beforeNaive,
    afterNaive,
    Array.from({ length: numArms }, (_, a) => naive.valueOf(a)),
  );
  const withReplay = makeResult(
    beforeRehearsal,
    afterRehearsal,
    Array.from({ length: numArms }, (_, a) => rehearsal.valueOf(a)),
  );
  return {
    withoutReplay,
    withReplay,
    protectedByRehearsal: withoutReplay.dropFraction > 0.5 && withReplay.retention >= 0.8,
    stream,
  };
}

// ── 接线建议 ─────────────────────────────────────────────────────────
//
// 1. 自主循环的「睡眠固化」正式阶段（心跳/夜间批处理）:
//    - 白天操作环经验逐条 push 进 PrioritizedReplay（task = 任务类型/
//      来源标签，tdError = 预测误差）；夜间阶段调 sleepConsolidation:
//      只重放不采新、IS 加权消化、|TD| 回写——把白天的经验离线固化成
//      策略改进，improvement 作为「这一觉值不值」的量化汇报进心智报告
//      （meta/self-model）。
//
// 2. 长期记忆分层配额（旧技能不被新洪峰覆盖）:
//    - 分层环的 quota 机制挂记忆库: 每个任务域（代码生成/翻译/工具调用）
//      一个层，容量按层公平配给——新域流量再大也挤不掉旧域的存活样本
//      （灾难遗忘的存储侧防线；锚点⑤的存活断言就是这条防线的验收）。
//
// 3. 策略进化环的样本效率层（与 88.0 OPE、21.0 Gittins 协同）:
//    - 高 |TD| 优先重放把离线学习预算集中到「预测错得最离谱」的经验上
//      （样本效率），IS 权重保证统计口径不被优先采样扭曲（无偏性）；
//      固化后的策略价值评估走 88.0 的离线评估阶梯——不上线就验收。
//
// 4. 与 97.0 元认知信心的内省闭环:
//    - 睡眠固化的 improvement 与元认知效率同表上报: 「知道自己不知道」
//      （97.0）圈出低信心区域，「睡一觉想明白」（98.0）对相应 task 层
//      加权固化——低信心 → 高重放配额的内省调度闭环。
//
// 5. 挂载边界（零介入承诺）:
//    - 只读挂载: 引擎仅调用缓冲区/固化/对照的显式方法，内核不自动采样
//      环境数据、不写引擎状态；未挂载时现有在线学习路径逐位一致。
// ──────────────────────────────────────────────────────────────────
