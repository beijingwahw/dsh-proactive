/**
 * 96.0 全局工作空间内核 —— 竞争广播的意识总线（Baars 全局工作空间理论的可计算化）
 *
 * 动机: 系统里从不缺少发现——Sentinel 嗅到异常爆发、决策引擎算出策略突破、
 * 反思引擎产出修正如、预算仲裁拉响告警、共生引擎提议新协作……但「此刻全体
 * 该知道什么」从未被计算过：现有链路是固定顺序的信息流（谁先挂载谁先说，
 * 谁在代码里排前面谁上头条），发现的相对重要性没有仲裁者。Baars 的全局
 * 工作空间理论（GWT）给出的答案是**竞争**：大量专门化模块（「无意识处理
 * 器」）并行工作，每一刻它们为唯一的「广播位」投标；胜者的内容写入全局
 * 工作空间（意识），瞬时广播给所有模块——广播本身成为下一轮全体计算的
 * 上下文。意识不是某个模块，是竞争胜出后的全局广播。
 *
 * 数学（五条动力学，全部确定性可复算；随机只经文件内 mulberry32(seed)）:
 *
 * (a) 竞争投标: 每步每个模块 i 提交分解投标（四元组，各分量 ∈ [0,1]，
 *     越界饱和裁剪、非有限数显式 throw）:
 *       b_i = (novelty 新奇度, relevance 与目标/广播上下文的关联度,
 *              confidence 模块自信度, urgency 紧急性)
 *     经优先级函数 P: [0,1]⁴ → [0,1] 合成标量投标。缺省线性加权（文档化、
 *     可注入，权重 const 对象 + 工厂 makeLinearPriority）:
 *       P(b) = 0.25·novelty + 0.30·relevance + 0.20·confidence + 0.25·urgency
 *     （新奇与关联主导意识入口，自信度保守——半信半疑的发现不该挤占头条）。
 *
 * (b) 点火（ignition）: 广播必须严格超过点火阈值 θ:
 *       点火 ⟺ ∃i: e_i > θ
 *     只有超阈候选（e_i > θ）有资格参与决胜；全体 ≤ θ 则维持总线现状
 *     （上一次广播仍驻留但不刷新、不通知）——「无意识处理」：专家模块继续
 *     并行计算，只是够不上意识入口。投标恰好等于 θ 不点火（「超过」取
 *     严格不等号）。
 *
 * (c) WTA 温度 T（winner-take-all 的软硬化）:
 *       T = 0 → 硬胜者: winner = argmax e_i（平票按裸优先 priority、再按
 *               模块注册序破平）——串行注意力焦点，一次只有一个意识内容；
 *       T > 0 → 软分配: winner ~ softmax(e/T)，p_i = exp(e_i/T)/Σ_j exp(e_j/T)
 *               在超阈候选上按概率采样广播——高温把注意力摊薄成均分；
 *       极限: T→0⁺ 时 softmax 退化为 argmax（与 T=0 口径一致）；T→∞ 时
 *               p → 均匀（广播位被均分）。
 *
 * (d) 不应期（refractory）: 刚广播的模块在随后 ω 步内被冷却——距胜 s 步
 *     （1 ≤ s ≤ ω）时其投标乘 δ^(ω+1−s)（δ ∈ (0,1) 缺省 0.5：越接近广播
 *     时刻折扣越重，第 ω 步末恢复到 δ，ω 步后完全恢复 ×1）。有效投标
 *       e_i = P(b_i) × δ^(ω+1−s)（不在不应期内则 ×1）
 *     恒强模块也会被冷却打断——注意力的生理不应期，防单模块垄断总线。
 *
 * (e) 广播级联: 胜者内容（sourceId + tags + 投标分解）写入总线；下一步
 *     所有模块的 priorityFn 以总线内容为上下文重算 relevance——「A 的发现
 *     让 B 突然相关」形成跨模块传播链（意识访问的级联），链自然熄灭
 *     （无人再超阈则总线驻留旧内容、不再通知）。
 *
 * 每步求解: ignited = |{i: e_i > θ}| > 0；winner = argmax_{i:e_i>θ} e_i
 *   （T=0）或 i ~ softmax(e/T)（T>0）；未点火时 winner/通知全空、总线驻留。
 *
 * 验证锚点（scripts/verify-global-workspace.mjs，全部确定性断言）:
 *   ① 硬 WTA: 5 模块已知优先级函数 × 30 步序列，胜者逐位等于脚本侧独立
 *      argmax 重算（含缺省权重手算锚 0.25/0.30/0.20/0.25）
 *   ② 点火阈值: 投标全 ≤ θ 的序列零广播（ignited 全 false、总线空、零通知、
 *      igniteRatio=0）；最高投标恰等于 θ 不点火（严格「超过」）；越过 θ
 *      当步立即点火；点火后回落则总线驻留旧内容（无意识处理 = 现状驻留）
 *   ③ 广播级联: 模块 B 只在广播含 'anomaly' 时投标高、C 只认 'escalated'——
 *      burst 信号 → A 广播 → B 次轮起爆 → C 第三轮接力 → 第四轮熄灭
 *      （传播链 3 环 + 熄灭 + 无 burst 对照组零点火）
 *   ④ 不应期: 恒强模块（0.95）vs 恒中模块（0.6），ω=2、δ=0.5 → 胜者严格
 *      A,B,A,B… 交替（垄断被打断；逐步有效投标手算 0.2375/0.475 对照）；
 *      ω=0 对照组恒强模块 12 连胜（无不应期即垄断）；恢复曲线 0.25→0.5→1
 *   ⑤ 软 WTA: 4 模块 0.9/0.7/0.5/0.3，N=2000 步——熵 H(T) 随
 *      0→0.05→0.3→1→∞ 严格递增，T=0 熵为 0，T→∞ 归一化熵 ≥ 0.995 且
 *      各模块频次 ∈ 均匀 ±6%；T=0.3 的分布与脚本侧独立 softmax 重算一致
 *   ⑥ 确定性: 同 seed 同输入 → 60 步轨迹（胜者/点火/有效投标）与订阅者
 *      回调内部状态逐位一致；异 seed（T>0）轨迹分离；igniteRatio/winCounts/
 *      bidSummary 与脚本侧独立重算一致
 *   附加: 入参显式 throw（空/重复模块、θ/T/ω/δ 越界、NaN 投标、坏 signals、
 *      权重和 ≠ 1、熵计数非正）；分量越界饱和裁剪不 throw
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】注意力温度的自适应退火（annealing，opt-in）：广播分布
 *     熵 H(T) 关于 T 单调不减（softmax 的热力学性质）——以目标归一化
 *     熵 H* 为设定点，每步按指数反馈
 *       T ← clamp(T·exp(κ·(H* − Ĥ)), T_min, ∞)，Ĥ = 点火步分布熵的 EMA
 *     驱动实际注意力均匀度收敛到设定点（熵高 → 降温聚焦、熵低 → 升温
 *     摊薄——垄断与噪声都由同一条反馈律矫正）。未配置 annealing 时
 *     currentTemperature 恒等于配置温度（零漂移）。
 *
 * A2【性能进化】runSequence 轨迹统计的增量维护：胜者直方图由
 *     O(模块数×步数) 的逐模块全轨迹重扫改为单遍增量计数 O(步数)，
 *     输出逐位相等（整数计数 + 同式舍入），大模块数长序列下耗时下降
 *     可测（verify 脚本 64 模块 × 20000 步计时对照）。
 *
 * A3【数值稳健】软 WTA 的溢出护栏：T 极小时 e/T → ±∞ 使 softmax 产生
 *     NaN——退化到 T→0⁺ 的解析极限（并列 argmax 集合上的均匀分布，
 *     rng 采样路径与常温一致），正常温度路径逐位不变；温度下限
 *     T_min 与 annealing 参数的显式校验。
 */

// ─────────────────────────── 数据结构 ───────────────────────────

/** 投标分解（各分量 ∈ [0,1]，越界饱和裁剪；非有限数显式 throw） */
export interface BidInput {
  /** 新奇度：内容偏离背景预期的程度 */
  novelty: number;
  /** 关联度：与当前目标 / 广播上下文的相关性（级联的载体） */
  relevance: number;
  /** 自信度：模块对自己发现的确定性 */
  confidence: number;
  /** 紧急性：延误代价 */
  urgency: number;
}

/** 步进时喂给 priorityFn 的外部上下文（世界信号 + 当前目标） */
export interface WorkspaceContext {
  /** 步序（内核计数器，0 起） */
  step: number;
  /** 外部信号标签（自由字符串，来自宿主世界） */
  signals: string[];
  /** 当前目标键（undefined = 无显式目标） */
  goal: string | undefined;
}

/** 总线状态视图（priorityFn 的第二个参数——广播上下文） */
export interface BroadcastState {
  /** 总线上是否有驻留广播 */
  active: boolean;
  sourceId: string | undefined;
  /** 广播发生步（active=false 时 -1） */
  step: number;
  /** 距广播的步数（active=false 时 +∞） */
  age: number;
  /** 广播内容标签 */
  tags: string[];
}

/** 广播内容（胜者写入总线的完整载荷；onBroadcast 的入参） */
export interface BroadcastContent {
  sourceId: string;
  step: number;
  /** 点火时刻的有效投标（含不应期折扣） */
  effectiveBid: number;
  /** 内容标签（胜者 describe 给出；未提供时缺省 [sourceId]） */
  tags: string[];
  /** 胜者的投标分解（审计：它为何赢） */
  components: BidInput;
}

/** 专门化模块（无意识处理器） */
export interface WorkspaceModule {
  id: string;
  /** 投标函数：外部上下文 × 总线上下文 → 投标分解（纯函数、确定性） */
  priorityFn: (ctx: WorkspaceContext, broadcast: BroadcastState) => BidInput;
  /** 广播内容标签生成（缺省 [id]；返回字符串数组） */
  describe?: (ctx: WorkspaceContext) => string[];
  /** 订阅回调：其它模块点火广播时被调用（确定性副作用——更新模块内部状态） */
  onBroadcast?: (content: BroadcastContent) => void;
}

/** 单步外部信号（step() 的入参；世界一拍内的可观察事件） */
export interface WorkspaceSignal {
  /** 外部信号标签（缺省 []） */
  signals?: string[];
  /** 当前目标键 */
  goal?: string;
}

/** 模块投标审计行 */
export interface ModuleBid {
  id: string;
  components: BidInput;
  /** 优先级函数合成后的标量投标 ∈ [0,1]（6 位小数舍入） */
  priority: number;
  /** 不应期折扣因子 ∈ (0,1]（不在不应期为 1） */
  refractoryFactor: number;
  /** 有效投标 = priority × refractoryFactor（决胜量） */
  effectiveBid: number;
  /** 是否超阈（点火候选资格：effectiveBid > θ） */
  eligible: boolean;
}

/** 胜者在超阈候选上的概率（T=0 为胜者单点 p=1；未点火为空数组） */
export interface WinnerProbability {
  id: string;
  p: number;
}

/** step() 单步结果 */
export interface StepResult {
  step: number;
  ignited: boolean;
  /** 胜者 id（未点火 undefined） */
  winner: string | undefined;
  /** 总线内容：点火 = 新广播；未点火 = 驻留旧广播（维持现状）；从未广播 = undefined */
  broadcast: BroadcastContent | undefined;
  /** 全部模块投标（含未超阈者，审计） */
  bids: ModuleBid[];
  /** 本步收到广播通知的模块（= 除胜者外全部，按模块序；未点火为空） */
  notified: string[];
  /** 胜者在超阈候选上的 softmax 概率（T=0: 单点 1；未点火: 空） */
  winnerDistribution: WinnerProbability[];
}

/** bidSummary 单模块统计行 */
export interface BidSummaryEntry {
  id: string;
  /** 参与投标的步数 */
  samples: number;
  meanPriority: number;
  maxPriority: number;
  minPriority: number;
  meanEffectiveBid: number;
  /** 广播获胜次数（= 点火并胜出） */
  wins: number;
  /** wins / 总步数 */
  winRate: number;
  /** wins / 总点火数（广播份额） */
  broadcastShare: number;
}

/** runSequence 轨迹（含广播分布熵——注意力均匀度的统一度量） */
export interface WorkspaceTrajectory {
  steps: StepResult[];
  totalSteps: number;
  ignitedSteps: number;
  igniteRatio: number;
  winCounts: Array<{ id: string; wins: number; share: number }>;
  /** 广播分布熵 −Σ p log₂ p（bit；零点火为 0） */
  entropyBits: number;
  /** 均匀分布熵上限 log₂(n)（bit；单模块为 0） */
  maxEntropyBits: number;
}

// ─────────────────────────── 优先级函数（文档化 + 可注入） ───────────────────────────

/** 线性优先级权重（缺省值即文档锚点：四项和 = 1，输出 ∈ [0,1]） */
export interface PriorityWeights {
  novelty: number;
  relevance: number;
  confidence: number;
  urgency: number;
}

/** 缺省优先级权重：新奇 0.25 / 关联 0.30 / 自信 0.20 / 紧急 0.25 */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  novelty: 0.25,
  relevance: 0.3,
  confidence: 0.2,
  urgency: 0.25,
};

/** 缺省优先级函数：线性加权（文档化；可被 makeLinearPriority / 任意注入替换） */
export function defaultPriority(b: BidInput): number {
  const w = DEFAULT_PRIORITY_WEIGHTS;
  return w.novelty * b.novelty + w.relevance * b.relevance + w.confidence * b.confidence + w.urgency * b.urgency;
}

/** 线性优先级工厂（权重可注入；要求非负且和为 1，显式 throw） */
export function makeLinearPriority(weights: PriorityWeights): (b: BidInput) => number {
  assertWeights(weights, 'makeLinearPriority');
  const w = { ...weights };
  return (b: BidInput): number =>
    w.novelty * b.novelty + w.relevance * b.relevance + w.confidence * b.confidence + w.urgency * b.urgency;
}

// ─────────────────────────── 配置（const 对象 + 类型，无 enum/namespace） ───────────────────────────

/** 内核缺省配置 */
export interface GlobalWorkspaceDefaults {
  /** 点火阈值 θ ∈ [0,1]（缺省 0.5：半数自信以下的发现不上总线） */
  threshold: number;
  /** WTA 温度 T ≥ 0（缺省 0 = 硬胜者串行注意力） */
  temperature: number;
  /** 不应期步数 ω ≥ 0（缺省 0 = 关闭；整数） */
  refractory: number;
  /** 不应期折扣底数 δ ∈ (0,1)（缺省 0.5） */
  refractoryFactor: number;
  /** RNG 种子（缺省 42） */
  seed: number;
}

export const DEFAULT_GLOBAL_WORKSPACE: GlobalWorkspaceDefaults = {
  threshold: 0.5,
  temperature: 0,
  refractory: 0,
  refractoryFactor: 0.5,
  seed: 42,
};

/** 构造参数（modules 必填，其余可覆盖缺省） */
export interface GlobalWorkspaceOptions {
  modules: WorkspaceModule[];
  threshold?: number;
  temperature?: number;
  refractory?: number;
  refractoryFactor?: number;
  priorityFn?: (b: BidInput) => number;
  seed?: number;
  /**
   * R5·A1 注意力温度自适应退火（opt-in；缺省 undefined = 恒温零漂移）。
   * 配置后温度按广播熵反馈每步调节（见头注 R5 段），currentTemperature() 可观测。
   */
  annealing?: AnnealingOptions;
}

/** R5·A1 退火参数（指数反馈律 T ← clamp(T·exp(κ(H*−Ĥ)), T_min, ∞)） */
export interface AnnealingOptions {
  /** 初始温度 T₀ > 0（取代 temperature 作为起点） */
  initial: number;
  /** 目标归一化广播熵 H* ∈ (0,1]（1 = 均匀注意力） */
  targetNormalizedEntropy: number;
  /** 反馈增益 κ > 0（每步温度乘子的指数尺度；过大振荡、过小迟缓） */
  adjustmentRate: number;
  /** 温度下限 T_min > 0（数值护栏 + 防完全冻结） */
  minTemperature: number;
  /** 熵 EMA 平滑系数 ∈ (0,1)（缺省 0.2） */
  entropyEmaAlpha?: number;
}

// ─────────────────────────── 内核实现 ───────────────────────────

/** 每模块投标累积器（bidSummary 的原料） */
interface BidAccumulator {
  n: number;
  sumPriority: number;
  maxPriority: number;
  minPriority: number;
  sumEffective: number;
}

/**
 * 全局工作空间：竞争 → 点火 → 广播 → 级联的可计算意识总线。
 *
 * 确定性契约: 同 (modules 逻辑, 配置, seed, 输入序列) → 逐位相同的结果；
 * 随机只发生在 T>0 的胜者采样（每点火步恰好消耗一次 rng，按模块序走
 * 累积概率），T=0 完全无随机。订阅者 onBroadcast 在胜者确定后按模块序
 * 同步调用（胜者自身不收自己的广播）。
 *
 * 消费方（只读方法，未挂载零介入）:
 * - 宿主调度总线: 17 引擎各自包装为模块，每拍 step({signals, goal})，
 *   ignited 时 broadcast 即「此刻全员该知道什么」
 * - 元认知: igniteRatio 作意识负荷 KPI、winCounts 熵监控垄断
 * - 与 99.0 注意力经济互补: 99 管持续资源分配，96 管单步广播焦点
 */
export class GlobalWorkspace {
  private readonly modules: WorkspaceModule[];
  private readonly moduleById: Map<string, WorkspaceModule>;
  private readonly threshold: number;
  private readonly temperature: number;
  private readonly refractory: number;
  private readonly refractoryBase: number;
  private readonly priorityFn: (b: BidInput) => number;
  private readonly seed: number;
  private rng: () => number;
  private stepCounter: number;
  private lastBroadcast: BroadcastContent | undefined;
  private readonly lastWinStep: Map<string, number>;
  private statSteps: number;
  private statIgnited: number;
  private readonly winCounts: Map<string, number>;
  private readonly bidAcc: Map<string, BidAccumulator>;
  /** R5·A1 退火状态（未配置 annealing 时恒等于配置温度） */
  private readonly annealing: AnnealingOptions | undefined;
  private readonly annealingInitialT: number;
  private annealingT: number;
  private annealingEntropyEma: number | undefined;

  constructor(options: GlobalWorkspaceOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('GlobalWorkspace: 构造参数需为 { modules, threshold?, temperature?, refractory?, refractoryFactor?, priorityFn?, seed? } 对象');
    }
    if (!Array.isArray(options.modules) || options.modules.length === 0) {
      throw new Error('GlobalWorkspace: modules 需为非空数组（至少一个专门化模块）');
    }
    this.modules = [...options.modules];
    this.moduleById = new Map();
    for (const m of this.modules) {
      if (!m || typeof m !== 'object') throw new Error('GlobalWorkspace: 每个模块需为对象');
      if (typeof m.id !== 'string' || m.id.length === 0) throw new Error('GlobalWorkspace: 模块 id 需为非空字符串');
      if (this.moduleById.has(m.id)) throw new Error(`GlobalWorkspace: 模块 id 重复: ${m.id}`);
      if (typeof m.priorityFn !== 'function') throw new Error(`GlobalWorkspace: 模块 ${m.id} 缺少 priorityFn(ctx, broadcast) 函数`);
      if (m.describe !== undefined && typeof m.describe !== 'function') throw new Error(`GlobalWorkspace: 模块 ${m.id} 的 describe 需为函数`);
      if (m.onBroadcast !== undefined && typeof m.onBroadcast !== 'function') throw new Error(`GlobalWorkspace: 模块 ${m.id} 的 onBroadcast 需为函数`);
      this.moduleById.set(m.id, m);
    }
    this.threshold = options.threshold ?? DEFAULT_GLOBAL_WORKSPACE.threshold;
    if (!Number.isFinite(this.threshold) || this.threshold < 0 || this.threshold > 1) {
      throw new Error(`GlobalWorkspace: 点火阈值 θ 需 ∈ [0,1]（收到 ${this.threshold}）`);
    }
    this.temperature = options.temperature ?? DEFAULT_GLOBAL_WORKSPACE.temperature;
    if (!Number.isFinite(this.temperature) || this.temperature < 0) {
      throw new Error(`GlobalWorkspace: WTA 温度 T 需为非负有限数（收到 ${this.temperature}）`);
    }
    this.refractory = options.refractory ?? DEFAULT_GLOBAL_WORKSPACE.refractory;
    if (!Number.isInteger(this.refractory) || this.refractory < 0) {
      throw new Error(`GlobalWorkspace: 不应期步数 ω 需为非负整数（收到 ${this.refractory}）`);
    }
    this.refractoryBase = options.refractoryFactor ?? DEFAULT_GLOBAL_WORKSPACE.refractoryFactor;
    if (!Number.isFinite(this.refractoryBase) || this.refractoryBase <= 0 || this.refractoryBase >= 1) {
      throw new Error(`GlobalWorkspace: 不应期折扣底数 δ 需 ∈ (0,1) 开区间（收到 ${this.refractoryBase}）`);
    }
    this.priorityFn = options.priorityFn ?? defaultPriority;
    if (typeof this.priorityFn !== 'function') {
      throw new Error('GlobalWorkspace: priorityFn 需为 (b: BidInput) => number 函数');
    }
    this.seed = options.seed ?? DEFAULT_GLOBAL_WORKSPACE.seed;
    if (!Number.isFinite(this.seed)) {
      throw new Error(`GlobalWorkspace: seed 需为有限数（收到 ${this.seed}）`);
    }

    // R5·A1 退火参数校验（opt-in；未配置时温度恒定零漂移）
    if (options.annealing !== undefined) {
      const a = options.annealing;
      if (!a || typeof a !== 'object') {
        throw new Error('GlobalWorkspace: annealing 需为 { initial, targetNormalizedEntropy, adjustmentRate, minTemperature } 对象');
      }
      if (!Number.isFinite(a.initial) || a.initial <= 0) {
        throw new Error(`GlobalWorkspace: annealing.initial 需为 > 0 有限数（收到 ${a.initial}）`);
      }
      if (!Number.isFinite(a.targetNormalizedEntropy) || a.targetNormalizedEntropy <= 0 || a.targetNormalizedEntropy > 1) {
        throw new Error(`GlobalWorkspace: annealing.targetNormalizedEntropy 需落在 (0,1]（收到 ${a.targetNormalizedEntropy}）`);
      }
      if (!Number.isFinite(a.adjustmentRate) || a.adjustmentRate <= 0) {
        throw new Error(`GlobalWorkspace: annealing.adjustmentRate 需为 > 0 有限数（收到 ${a.adjustmentRate}）`);
      }
      if (!Number.isFinite(a.minTemperature) || a.minTemperature <= 0) {
        throw new Error(`GlobalWorkspace: annealing.minTemperature 需为 > 0 有限数（收到 ${a.minTemperature}）`);
      }
      if (a.initial < a.minTemperature) {
        throw new Error(`GlobalWorkspace: annealing.initial（${a.initial}）不能低于 minTemperature（${a.minTemperature}）`);
      }
      if (a.entropyEmaAlpha !== undefined && (!Number.isFinite(a.entropyEmaAlpha) || a.entropyEmaAlpha <= 0 || a.entropyEmaAlpha >= 1)) {
        throw new Error(`GlobalWorkspace: annealing.entropyEmaAlpha 需落在开区间 (0,1)（收到 ${a.entropyEmaAlpha}）`);
      }
      this.annealing = { ...a };
      this.annealingInitialT = a.initial;
      this.annealingT = a.initial;
      this.annealingEntropyEma = undefined;
    } else {
      this.annealing = undefined;
      this.annealingInitialT = this.temperature;
      this.annealingT = this.temperature;
      this.annealingEntropyEma = undefined;
    }

    this.rng = mulberry32(this.seed);
    this.stepCounter = 0;
    this.lastBroadcast = undefined;
    this.lastWinStep = new Map();
    this.statSteps = 0;
    this.statIgnited = 0;
    this.winCounts = new Map();
    this.bidAcc = new Map();
    for (const m of this.modules) {
      this.winCounts.set(m.id, 0);
      this.bidAcc.set(m.id, { n: 0, sumPriority: 0, maxPriority: -Infinity, minPriority: Infinity, sumEffective: 0 });
    }
  }

  // ─────────────────────────── 单步动力学 ───────────────────────────

  /**
   * 推进一拍：全体模块投标 → 不应期折扣 → 点火判定 → （软/硬）WTA →
   * 广播 + 订阅通知。未点火时总线驻留旧内容（维持现状）。
   */
  step(signal: WorkspaceSignal = {}): StepResult {
    if (signal === null || typeof signal !== 'object') {
      throw new Error('GlobalWorkspace.step: signal 需为 { signals?, goal? } 对象');
    }
    let signals: string[] = [];
    if (signal.signals !== undefined) {
      if (!Array.isArray(signal.signals)) throw new Error('GlobalWorkspace.step: signals 需为字符串数组');
      for (const s of signal.signals) {
        if (typeof s !== 'string') throw new Error('GlobalWorkspace.step: signals 元素需为字符串');
      }
      signals = [...signal.signals];
    }
    const goal = signal.goal;
    if (goal !== undefined && typeof goal !== 'string') {
      throw new Error('GlobalWorkspace.step: goal 需为字符串');
    }

    const stepIndex = this.stepCounter;
    const ctx: WorkspaceContext = { step: stepIndex, signals, goal };
    const bus = this.busState();

    // (a) 竞争投标 + (d) 不应期折扣
    const bids: ModuleBid[] = [];
    for (const m of this.modules) {
      const comps = normalizeBid(m.priorityFn(ctx, bus), m.id);
      const pRaw = this.priorityFn(comps);
      if (typeof pRaw !== 'number' || !Number.isFinite(pRaw)) {
        throw new Error(`GlobalWorkspace: 模块 ${m.id} 的优先级函数返回非有限数（${String(pRaw)}）`);
      }
      const priority = round6(clip01(pRaw));
      const lastWin = this.lastWinStep.get(m.id);
      const sinceWin = lastWin === undefined ? Number.POSITIVE_INFINITY : stepIndex - lastWin;
      const inRefractory = sinceWin >= 1 && sinceWin <= this.refractory;
      const refractoryFactor = round6(inRefractory ? Math.pow(this.refractoryBase, this.refractory + 1 - sinceWin) : 1);
      const effectiveBid = round6(priority * refractoryFactor);
      bids.push({ id: m.id, components: comps, priority, refractoryFactor, effectiveBid, eligible: effectiveBid > this.threshold });

      const acc = this.bidAcc.get(m.id);
      if (acc) {
        acc.n += 1;
        acc.sumPriority += priority;
        acc.sumEffective += effectiveBid;
        if (priority > acc.maxPriority) acc.maxPriority = priority;
        if (priority < acc.minPriority) acc.minPriority = priority;
      }
    }

    this.stepCounter += 1;
    this.statSteps += 1;

    // (b) 点火判定：超阈候选为空 → 无意识处理（维持现状，不通知）
    const candidates = bids.filter((b) => b.eligible);
    if (candidates.length === 0) {
      return {
        step: stepIndex,
        ignited: false,
        winner: undefined,
        broadcast: this.lastBroadcast ? copyContent(this.lastBroadcast) : undefined,
        bids,
        notified: [],
        winnerDistribution: [],
      };
    }

    // (c) WTA：硬 argmax（T=0）或 softmax 采样（T>0），只在超阈候选上
    // R5：T 取自退火状态（未配置退火时恒等于配置温度——零漂移）
    let winnerBid: ModuleBid | undefined;
    let distribution: WinnerProbability[];
    if (this.annealingT === 0) {
      winnerBid = candidates[0];
      for (const c of candidates) {
        if (!winnerBid || c.effectiveBid > winnerBid.effectiveBid || (c.effectiveBid === winnerBid.effectiveBid && c.priority > winnerBid.priority)) {
          winnerBid = c;
        }
      }
      distribution = [{ id: winnerBid.id, p: 1 }];
    } else {
      const zs = candidates.map((b) => b.effectiveBid / this.annealingT);
      // R5·A3 溢出护栏：T 极小 → e/T 上溢 ±∞ → softmax NaN。
      // 退化到 T→0⁺ 解析极限：并列 argmax 集合上的均匀分布。
      const overflow = zs.some((z) => !Number.isFinite(z));
      if (overflow) {
        let maxBid = candidates[0]!;
        for (const c of candidates) {
          if (c.effectiveBid > maxBid.effectiveBid) {
            maxBid = c;
          }
        }
        // T→0⁺ 极限：softmax 只看有效投标——并列 argmax 集合上均匀
        const tied = candidates.filter((c) => c.effectiveBid === maxBid.effectiveBid);
        const p = round6(1 / tied.length);
        distribution = tied.map((c) => ({ id: c.id, p }));
        const u = this.rng();
        let cum = 0;
        let pick = tied.length - 1;
        for (let i = 0; i < tied.length; i += 1) {
          cum += p;
          if (u < cum) {
            pick = i;
            break;
          }
        }
        winnerBid = tied[pick];
      } else {
        const probs = softmax(zs);
        const u = this.rng();
        let cum = 0;
        let pick = probs.length - 1;
        for (let i = 0; i < probs.length; i += 1) {
          cum += probs[i] ?? 0;
          if (u < cum) {
            pick = i;
            break;
          }
        }
        winnerBid = candidates[pick];
        distribution = candidates.map((b, i) => ({ id: b.id, p: round6(probs[i] ?? 0) }));
      }
    }
    const winner = winnerBid;
    const winnerModule = this.moduleById.get(winner.id);
    if (!winnerModule) throw new Error(`GlobalWorkspace: 胜者 ${winner.id} 不在模块表中（内部一致性破坏）`);

    // (e) 广播：胜者内容写入总线，订阅者（其余模块）按模块序同步通知
    const tags = winnerModule.describe
      ? validateTags(winnerModule.describe(ctx), winnerModule.id)
      : [winnerModule.id];
    const content: BroadcastContent = {
      sourceId: winner.id,
      step: stepIndex,
      effectiveBid: winner.effectiveBid,
      tags,
      components: winner.components,
    };
    this.lastBroadcast = content;
    this.lastWinStep.set(winner.id, stepIndex);
    this.statIgnited += 1;
    this.winCounts.set(winner.id, (this.winCounts.get(winner.id) ?? 0) + 1);

    // R5·A1 退火反馈：点火步的分布熵（超阈候选上）→ EMA → 指数调节温度
    if (this.annealing) {
      const a = this.annealing;
      const alpha = a.entropyEmaAlpha ?? 0.2;
      let hBits = 0;
      for (const w of distribution) {
        if (w.p > 0) hBits -= w.p * Math.log2(w.p);
      }
      const norm = distribution.length > 1 ? hBits / Math.log2(distribution.length) : 1;
      this.annealingEntropyEma =
        this.annealingEntropyEma === undefined ? norm : (1 - alpha) * this.annealingEntropyEma + alpha * norm;
      // H 低于目标 → H*−norm > 0 → 升温摊薄；高于目标 → 降温聚焦（反馈把实际熵拉回设定点）
      const factor = Math.exp(a.adjustmentRate * (a.targetNormalizedEntropy - this.annealingEntropyEma));
      this.annealingT = Math.max(a.minTemperature, this.annealingT * factor);
    }

    const notified: string[] = [];
    for (const m of this.modules) {
      if (m.id === winner.id) continue;
      notified.push(m.id);
      if (m.onBroadcast) m.onBroadcast(content);
    }

    return {
      step: stepIndex,
      ignited: true,
      winner: winner.id,
      broadcast: copyContent(content),
      bids,
      notified,
      winnerDistribution: distribution,
    };
  }

  /**
   * 序列轨迹：依次推进并汇总（点火率 / 胜者直方图 / 广播分布熵）。
   * 统计只来自本序列（与此前 step 调用无关）。
   *
   * R5·A2：胜者直方图单遍增量计数（原为逐模块全轨迹重扫 O(M·L)，
   * 现 O(L)）；整数计数与同式舍入——输出逐位相等。
   */
  runSequence(signals: WorkspaceSignal[]): WorkspaceTrajectory {
    if (!Array.isArray(signals)) throw new Error('GlobalWorkspace.runSequence: signals 需为 WorkspaceSignal 数组');
    const steps: StepResult[] = [];
    const incrementalWins = new Map<string, number>();
    let ignitedSteps = 0;
    for (const s of signals) {
      const r = this.step(s);
      steps.push(r);
      if (r.ignited) {
        ignitedSteps += 1;
        incrementalWins.set(r.winner!, (incrementalWins.get(r.winner!) ?? 0) + 1);
      }
    }
    const totalSteps = steps.length;
    const winCounts = this.modules.map((m) => {
      const wins = incrementalWins.get(m.id) ?? 0;
      return { id: m.id, wins, share: ignitedSteps > 0 ? round6(wins / ignitedSteps) : 0 };
    });
    const entropyBits = ignitedSteps > 0 ? shannonEntropyBits(winCounts.map((w) => w.wins)) : 0;
    return {
      steps,
      totalSteps,
      ignitedSteps,
      igniteRatio: totalSteps > 0 ? round6(ignitedSteps / totalSteps) : 0,
      winCounts,
      entropyBits: round6(entropyBits),
      maxEntropyBits: round6(Math.log2(this.modules.length)),
    };
  }

  /** R5·A1 当前温度读出（未配置退火 = 配置温度恒定） */
  currentTemperature(): number {
    return this.annealingT;
  }

  /** R5·A1 退火状态读出（熵 EMA 与目标带；未配置退火 undefined） */
  annealingState(): { temperature: number; entropyEma: number | undefined; target: number } | undefined {
    if (!this.annealing) return undefined;
    return {
      temperature: round6(this.annealingT),
      entropyEma: this.annealingEntropyEma === undefined ? undefined : round6(this.annealingEntropyEma),
      target: this.annealing.targetNormalizedEntropy,
    };
  }

  /** 总线状态视图（以「下一步」视角报告 age；从未广播时 active=false） */
  busState(): BroadcastState {
    if (!this.lastBroadcast) {
      return { active: false, sourceId: undefined, step: -1, age: Number.POSITIVE_INFINITY, tags: [] };
    }
    return {
      active: true,
      sourceId: this.lastBroadcast.sourceId,
      step: this.lastBroadcast.step,
      age: this.stepCounter - this.lastBroadcast.step,
      tags: [...this.lastBroadcast.tags],
    };
  }

  /** 点火率（点火步数 / 总步数；未运行为 0） */
  igniteRatio(): number {
    return this.statSteps > 0 ? round6(this.statIgnited / this.statSteps) : 0;
  }

  /** 已推进步数 */
  totalSteps(): number {
    return this.statSteps;
  }

  /** 全部模块投标统计（审计：谁在投标、投多高、赢多少） */
  bidSummary(): BidSummaryEntry[] {
    return this.modules.map((m) => {
      const acc = this.bidAcc.get(m.id) ?? { n: 0, sumPriority: 0, maxPriority: 0, minPriority: 0, sumEffective: 0 };
      const wins = this.winCounts.get(m.id) ?? 0;
      return {
        id: m.id,
        samples: acc.n,
        meanPriority: acc.n > 0 ? round6(acc.sumPriority / acc.n) : 0,
        maxPriority: round6(acc.maxPriority),
        minPriority: acc.n > 0 ? round6(acc.minPriority) : 0,
        meanEffectiveBid: acc.n > 0 ? round6(acc.sumEffective / acc.n) : 0,
        wins,
        winRate: this.statSteps > 0 ? round6(wins / this.statSteps) : 0,
        broadcastShare: this.statIgnited > 0 ? round6(wins / this.statIgnited) : 0,
      };
    });
  }

  /** 复位：步数/总线/不应期/统计/退火清零，RNG 回种（同 seed 同输入可逐位复放） */
  reset(): void {
    this.rng = mulberry32(this.seed);
    this.stepCounter = 0;
    this.lastBroadcast = undefined;
    this.lastWinStep.clear();
    this.statSteps = 0;
    this.statIgnited = 0;
    // R5：退火状态回初温（复位 = 可逐位复放的完整时间倒带）
    this.annealingT = this.annealingInitialT;
    this.annealingEntropyEma = undefined;
    for (const m of this.modules) {
      this.winCounts.set(m.id, 0);
      this.bidAcc.set(m.id, { n: 0, sumPriority: 0, maxPriority: -Infinity, minPriority: Infinity, sumEffective: 0 });
    }
  }
}

// ─────────────────────────── 工具 ───────────────────────────

/** 确定性 RNG（mulberry32；本内核唯一随机源，T=0 时零消耗） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 数值稳定的 softmax（先减最大指数） */
function softmax(z: number[]): number[] {
  let m = -Infinity;
  for (const v of z) if (v > m) m = v;
  const e = z.map((v) => Math.exp(v - m));
  let s = 0;
  for (const v of e) s += v;
  return e.map((v) => v / s);
}

/** 饱和裁剪到 [0,1]（越界不 throw——文档化的饱和语义） */
function clip01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round6(x: number): number {
  return Number(x.toFixed(6));
}

function copyContent(c: BroadcastContent): BroadcastContent {
  return { sourceId: c.sourceId, step: c.step, effectiveBid: c.effectiveBid, tags: [...c.tags], components: { ...c.components } };
}

/** 校验 + 规范化模块投标分解（四分量有限数；越界饱和裁剪） */
function normalizeBid(raw: BidInput, moduleId: string): BidInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`GlobalWorkspace: 模块 ${moduleId} 的 priorityFn 需返回 { novelty, relevance, confidence, urgency }`);
  }
  const fields: Array<keyof BidInput> = ['novelty', 'relevance', 'confidence', 'urgency'];
  const out = {} as BidInput;
  for (const f of fields) {
    const v = raw[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`GlobalWorkspace: 模块 ${moduleId} 的投标分量 ${f} 需为有限数（收到 ${String(v)}）`);
    }
    out[f] = clip01(v);
  }
  return out;
}

/** 校验 describe 返回的标签数组 */
function validateTags(tags: string[], moduleId: string): string[] {
  if (!Array.isArray(tags)) throw new Error(`GlobalWorkspace: 模块 ${moduleId} 的 describe 需返回字符串数组`);
  for (const t of tags) {
    if (typeof t !== 'string') throw new Error(`GlobalWorkspace: 模块 ${moduleId} 的 describe 标签需为字符串`);
  }
  return [...tags];
}

/** 校验线性优先级权重（非负、和为 1） */
function assertWeights(w: PriorityWeights, who: string): void {
  if (!w || typeof w !== 'object') throw new Error(`${who}: 权重需为 { novelty, relevance, confidence, urgency } 对象`);
  const fields: Array<keyof PriorityWeights> = ['novelty', 'relevance', 'confidence', 'urgency'];
  let sum = 0;
  for (const f of fields) {
    const v = w[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`${who}: 权重 ${f} 需为非负有限数（收到 ${String(v)}）`);
    }
    sum += v;
  }
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`${who}: 权重和需为 1（实际 ${sum}）——保证优先级输出 ∈ [0,1]`);
  }
}

/** 香农熵（bit）：−Σ pᵢ log₂ pᵢ，pᵢ = cᵢ/Σc（计数非负、总和 > 0） */
export function shannonEntropyBits(counts: number[]): number {
  if (!Array.isArray(counts) || counts.length === 0) throw new Error('shannonEntropyBits: counts 需为非空数组');
  let total = 0;
  for (const c of counts) {
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) {
      throw new Error(`shannonEntropyBits: 计数需为非负有限数（收到 ${String(c)}）`);
    }
    total += c;
  }
  if (total <= 0) throw new Error('shannonEntropyBits: 计数全零（无分布可言）');
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return round6(h);
}

/* ── 接线建议 ──
 * 建议挂载引擎: 全局调度总线（17 引擎的意识层仲裁）与元认知。
 *   1. 跨引擎意识总线: 每引擎包装为 WorkspaceModule——Sentinel/决策/反思/
 *      进化/共生等各自实现 priorityFn（novelty 取 novelty-detection 的惊奇
 *      分数、relevance 取与当前 goal 键的关联、confidence 取引擎自报可信度、
 *      urgency 取延误代价 / SLA 余量），describe 给出内容标签（异常爆发 /
 *      策略突破 / 预算告警……）。宿主每拍调用 step({ signals, goal })，
 *      ignited 时把 broadcast 分发全员（onBroadcast 或总线消费）——
 *      「此刻全员该知道什么」由竞争仲裁，不再由代码调用顺序决定；下一拍
 *      全体模块以广播为上下文重算 relevance（级联传播）。
 *   2. 与 99.0 注意力经济互补: 99 管持续资源分配（预算/算力在引擎间的
 *      长期配给），96 管单步广播焦点（这一拍谁上头条）；96 的胜者广播可
 *      作为 99 的需求信号输入，99 的配给结果可作为模块 confidence 的先验
 *      ——两轴各自独立、单向解耦、互不侵入。
 *   3. 元认知: igniteRatio 作「意识负荷」KPI（长期偏低 → θ 过高或模块
 *      迟钝；长期 ≈ 1 → θ 过低、噪声上头条）；winCounts 分布熵监控垄断
 *      （单模块长期霸屏 → 调大 ω 或升温 T 摊薄注意力）。
 *   缺省关闭旗标名: enableGlobalWorkspaceKernel（缺省 false；旗标关闭时
 *      信息流走原有固定顺序链路）。
 *   挂载后改变的决策点: ① 跨引擎发现的播报顺序与篇幅（原为代码调用序，
 *      改为投标竞争 + 点火阈值仲裁）；② 每拍全员上下文（原为各引擎自行
 *      拉取，改为胜者内容广播后重算 relevance）；③ 异常/突破的头条归属
 *      （原为最近发生者胜，改为 novelty×relevance×confidence×urgency 的
 *      数学合成 + 不应期防垄断）。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
