/**
 * consolidation.ts — τ2 结构固化器（双系统可塑性 · 第二阶段）
 *
 * 定位：把 τ1 在线学习**反复证实**的偏好结构蒸馏为显式规则——
 * 海马体（τ1：快、连续、会遗忘）→ 新皮层（τ2：慢、离散、持久）的
 * 睡眠固化的工程形态。三段式（对齐 DGM 的「变体-验证-档案」）：
 *
 * 1. 稳定结构检测（train 窗，无时间衰减——结构检测要看长程稳定性，
 *    遗忘是 τ1 的职责）：逐臂按节点级真值聚合成功计数，最优臂须在
 *    train 的全部子窗口中压过次优臂（符号稳定）且均值差距 ≥ margin；
 * 2. 保持集经验证（test 窗 = 最近 1/3 事件，DGM 的「经验证的改进」）：
 *    候选臂在未见数据上仍须压过次优臂——train 上过拟合的假结构在此
 *    被拒（档案记 reject）；
 * 3. 版本化规则档案：promote / reject / retire 三类条目，sha256 链式
 *    哈希（与账本/学习链同构），原子落盘。规则**从不原地改写**——
 *    换偏好 = 旧规则 retire + 新规则 promote，历史可回放可审计。
 *
 * 持久性语义（与 τ1 的本质区别）：τ1 乘数随 30 天半衰期衰减归零；
 * τ2 规则在退役前**一直生效**——结构比证据活得久。每个固化和周期
 * 都重新过保持集：世界反转 → 规则被 retire（行为恢复 τ1 口径），
 * 这就是「退役」而非「删除」：档案保留全部痕迹。
 *
 * 零漂移：不修改既有文件行为；消费方（调度评分链）以可选挂载接入，
 * 未挂载恒为中性乘数 1。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TaskOutcomeSignal } from './loop.js';

// ─────────────────────────── 规则与档案 ───────────────────────────

/** 持久偏好规则（结构学习的最小单元：在哪个上下文、哪个臂、多大优势、何时固化） */
export interface PreferenceRule {
  /** 规则 id（同 (上下文,臂) 重复固化为新版本，id 带版本号） */
  id: string;
  /** 被偏好的臂（= PlasticityLoop 臂名，如 model:m1） */
  armId: string;
  /**
   * 上下文前提（结算信号的 taskContext，如信号类型）：undefined = 全局
   * 规则。查找语义：精确上下文匹配的规则压过全局规则（更具体的
   * 结构支配更泛的结构）。
   */
  taskContext?: string;
  /** train 窗上的优势幅度（成功率差） */
  margin: number;
  /** 保持集上复现的优势幅度 */
  holdoutMargin: number;
  bornAt: number;
  /** 出生证据：train/test 事件数与双方计数（可审计） */
  evidence: {
    trainEvents: number;
    testEvents: number;
    trainCounts: Record<string, [number, number]>;
    testCounts: Record<string, [number, number]>;
  };
}

/** 档案条目（append-only；三类动作） */
export interface ArchiveEntry {
  seq: number;
  kind: 'promote' | 'reject' | 'retire';
  /** 相关规则 id（reject 为被拒候选的假想 id） */
  ruleId: string;
  armId: string;
  /** 上下文前提（undefined = 全局桶） */
  taskContext?: string;
  at: number;
  /** 链哈希（sha256(prev + 本条内容)） */
  hash: string;
  /** 拒绝/退役原因（人可读） */
  reason?: string;
}

export interface ConsolidatorConfig {
  /** 触发固化的最少事件数（缺省 120） */
  minEvents?: number;
  /**
   * 结构检测的滑动地平线：每桶只取最近 window 事件做 train/test
   * （缺省 600；0 = 全历史）。全历史口径会让早期稀疏探索时代永久
   * 稀释子窗口稳定性检查——结构是「近来」的性质，与 τ1 的证据衰减
   * 哲学对齐。
   */
  window?: number;
  /** 每多少事件自动固化一次（缺省 200；onEvent 计数触发） */
  interval?: number;
  /** train 子窗口数（符号稳定性检查；缺省 3） */
  subWindows?: number;
  /** 候选臂最少样本数（缺省 20） */
  minArmSamples?: number;
  /** 稳定优势门槛（成功率差；缺省 0.1） */
  margin?: number;
  /** 保持集允许的优势回吐（test ≥ train − tol 才算复现；缺省 0.05） */
  holdoutTolerance?: number;
  /** 持久乘数上限（缺省 0.25 → 乘数 ∈ [1, 1.25]） */
  maxBonus?: number;
  /**
   * 创世纪 G2 · 准备金率：规则发行的最低保持集优势（缺省 0.1）——
   * 结构是央行发行的债券，holdoutMargin 就是准备金；低于准备金的
   * 候选不得发行（防劣质结构流通）。
   */
  reserveRatio?: number;
  /**
   * 创世纪 G2 · 资本充足率 κ：Σ(活跃规则影响力) ≤ κ × 证据基础
   * （缺省 0.01）。证据基础 = 当前经验流的节点级观测数。越界时按
   * holdoutMargin 升序强制退役最弱规则直至回到界内——结构不许超发。
   */
  capitalKappa?: number;
  /** 档案/规则持久化路径（缺省内存态） */
  persistPath?: string;
}

export interface ConsolidatorStats {
  consolidations: number;
  activeRules: PreferenceRule[];
  archiveEntries: number;
  chainIntact: boolean;
  lastOutcome: { kind: ArchiveEntry['kind']; ruleId: string } | undefined;
}

// ─────────────────────────── 固化器 ───────────────────────────

export class Consolidator {
  private readonly cfg: Required<Omit<ConsolidatorConfig, 'persistPath'>>;
  private readonly persistPath: string | undefined;
  private rules: PreferenceRule[] = [];
  private archive: ArchiveEntry[] = [];
  private chainHead = '0'.repeat(64);
  private consolidations = 0;
  private eventsSinceRun = 0;
  private lastOutcome: { kind: ArchiveEntry['kind']; ruleId: string } | undefined;

  constructor(config: ConsolidatorConfig = {}) {
    this.cfg = {
      minEvents: Math.max(60, config.minEvents ?? 120),
      window: Math.max(0, config.window ?? 600),
      interval: Math.max(1, config.interval ?? 200),
      subWindows: Math.max(2, config.subWindows ?? 3),
      minArmSamples: Math.max(5, config.minArmSamples ?? 20),
      margin: Math.min(0.9, Math.max(0.02, config.margin ?? 0.1)),
      holdoutTolerance: Math.min(0.5, Math.max(0, config.holdoutTolerance ?? 0.05)),
      maxBonus: Math.min(1, Math.max(0.05, config.maxBonus ?? 0.25)),
      reserveRatio: Math.min(0.9, Math.max(0, config.reserveRatio ?? 0.1)),
      capitalKappa: Math.min(1, Math.max(0.0001, config.capitalKappa ?? 0.01)),
    };
    this.persistPath = config.persistPath;
    if (this.persistPath) this.loadFromDisk();
  }

  /**
   * 结算事件回调（桥接层每次 observeTask 后调用）：计数达 interval
   * 自动固化。返回是否触发了固化。
   */
  onEvent(): boolean {
    this.eventsSinceRun += 1;
    if (this.eventsSinceRun < this.cfg.interval) return false;
    this.eventsSinceRun = 0;
    this.consolidate();
    return true;
  }

  /**
   * 执行一轮固化（幂等安全，可显式调用）：
   * 按 taskContext 分桶，每桶独立走「检测稳定结构 → 保持集验证 →
   * promote / reject / retire」；无上下文标签的事件落全局桶。
   */
  consolidate(now: number = Date.now()): void {
    this.consolidations += 1;
    const events = this.sourceEvents();
    if (events.length < this.cfg.minEvents) return;
    const buckets = new Map<string, TaskOutcomeSignal[]>();
    for (const e of events) {
      const key = e.taskContext ?? '';
      const bucket = buckets.get(key);
      if (bucket) bucket.push(e);
      else buckets.set(key, [e]);
    }
    for (const [key, bucket] of buckets) {
      if (bucket.length < this.cfg.minEvents) continue; // 桶内证据不足：该上下文无结构可言
      this.consolidateBucket(key === '' ? undefined : key, bucket, now);
    }
    // 创世纪 G2 · 资本充足率：Σ(结构影响力) ≤ κ × 证据基础（节点级观测数）
    this.evidenceBase = events.reduce((sum, e) => sum + e.contributors.length, 0);
    this.enforceCapitalAdequacy(now);
  }

  /** 当前证据基础（最近一次固化的口径；审计/统计用） */
  private evidenceBase = 0;

  /** 单桶固化（原 consolidate 主体；context = undefined 即全局桶） */
  private consolidateBucket(context: string | undefined, events: ReadonlyArray<TaskOutcomeSignal>, now: number): void {
    // 滑动地平线：结构是「近来」的性质——全历史会让早期稀疏时代
    // 永久稀释稳定性检查（soak 实测：燃烧期探索流量稀疏 + 漂移期
    // 结构成熟，全历史 train 永远配不成对）
    const horizon = this.cfg.window > 0 && events.length > this.cfg.window ? events.slice(-this.cfg.window) : events;
    const split = Math.floor((horizon.length * 2) / 3);
    const train = horizon.slice(0, split);
    const test = horizon.slice(split);
    const trainCounts = armCounts(train);
    const testCounts = armCounts(test);
    const ranking = rankArms(trainCounts, this.cfg.minArmSamples);
    const active = this.rules.find((r) => (r.taskContext ?? undefined) === context);

    // 在位规则的再验证：保持集上不再压过次优 → 退役（世界反转的诚实出口）
    if (active) {
      const holdout = holdoutEdge(testCounts, active.armId, this.cfg.minArmSamples);
      if (holdout === undefined || holdout <= 0) {
        this.retire(active, now, holdout === undefined ? '保持集样本不足，结构失去支撑' : '保持集优势消失（世界反转或漂移）');
      }
    }

    if (ranking.length < 2) return; // 无可比较的臂对：没有结构可言
    const [best, second] = ranking;

    // 在位规则仍是当前最优 → 不重复固化（结构稳定 = 无新结构）
    if (active && active.armId === best.id) return;

    // 稳定性：train 全部子窗口中 best 均压过 second（符号稳定，防单窗假象）
    if (!stableAcrossSubWindows(train, best.id, second.id, this.cfg.subWindows, this.cfg.minArmSamples)) return;
    const trainMargin = best.rate - second.rate;
    if (trainMargin < this.cfg.margin) return;

    // 保持集验证：未见数据上复现优势（DGM 的「经验证的改进」）。
    // 容差 = max(配置下限, 2σ 采样噪声)：固定小容差会把真结构误杀——
    // n=50/臂 时优势估计的 σ≈0.09，±2σ 摆动 0.18 远超 0.05；
    // 噪声地板随样本量收敛，小样本宽容、大样本严格。
    const holdoutMargin = holdoutEdge(testCounts, best.id, this.cfg.minArmSamples);
    const candidateId = `prefer-${context ? `${context}@` : ''}${best.id}`;
    if (holdoutMargin === undefined || holdoutMargin <= 0) {
      this.append({ kind: 'reject', ruleId: candidateId, armId: best.id, taskContext: context, at: now, reason: holdoutMargin === undefined ? '保持集样本不足' : '保持集优势消失（未见数据上不复现）' });
      return;
    }
    const noiseTol = Math.max(this.cfg.holdoutTolerance, 2 * marginSamplingSigma(testCounts, best.id, second.id));
    if (holdoutMargin < trainMargin - noiseTol) {
      this.append({ kind: 'reject', ruleId: candidateId, armId: best.id, taskContext: context, at: now, reason: `保持集优势 ${holdoutMargin.toFixed(3)} 未复现 train ${trainMargin.toFixed(3)}（噪声地板 ±${noiseTol.toFixed(3)}）` });
      return;
    }
    // 创世纪 G2 · 准备金率：holdoutMargin 是结构发行的准备金——
    // 低于准备金率的候选不得发行（劣质结构不进入流通）
    if (holdoutMargin < this.cfg.reserveRatio) {
      this.append({ kind: 'reject', ruleId: candidateId, armId: best.id, taskContext: context, at: now, reason: `准备金不足：保持集优势 ${holdoutMargin.toFixed(3)} < 准备金率 ${this.cfg.reserveRatio}` });
      return;
    }

    // 换偏好：旧规则退役 + 新规则晋升（结构变更全程留痕）
    if (active && active.armId !== best.id) this.retire(active, now, `被 ${best.id} 的稳定优势取代`);
    const rule: PreferenceRule = {
      id: `${candidateId}-v${this.nextVersion(context, best.id)}`,
      armId: best.id,
      taskContext: context,
      margin: Number(trainMargin.toFixed(4)),
      holdoutMargin: Number(holdoutMargin.toFixed(4)),
      bornAt: now,
      evidence: {
        trainEvents: train.length,
        testEvents: test.length,
        trainCounts: Object.fromEntries([...trainCounts].map(([id, c]) => [id, [c.successes, c.failures]])),
        testCounts: Object.fromEntries([...testCounts].map(([id, c]) => [id, [c.successes, c.failures]])),
      },
    };
    this.rules = this.rules.filter((r) => r.id !== active?.id).concat(rule);
    this.append({ kind: 'promote', ruleId: rule.id, armId: rule.armId, taskContext: context, at: now });
  }

  /** 当前生效规则（每个上下文桶至多一条——桶内偏好是全序） */
  activeRules(): PreferenceRule[] {
    return this.rules.map((r) => ({ ...r, evidence: cloneEvidence(r.evidence) }));
  }

  // ── 创世纪 G2 · 结构央行 ──

  /** 规则的结构影响力（流通额度） */
  private influenceOf(rule: PreferenceRule): number {
    return Math.min(this.cfg.maxBonus, Math.max(0, rule.holdoutMargin));
  }

  /**
   * 资本充足率强制执行：Σ(活跃规则影响力) ≤ κ × 证据基础。
   * 越界时按 holdoutMargin 升序强制退役最弱规则直至回到界内——
   * 结构不许超发（小证据基础上限发结构 = 无准备金银行）。
   */
  private enforceCapitalAdequacy(now: number): void {
    if (this.evidenceBase === 0) return;
    const capacity = this.cfg.capitalKappa * this.evidenceBase;
    let total = this.rules.reduce((s, r) => s + this.influenceOf(r), 0);
    while (total > capacity && this.rules.length > 0) {
      const weakest = [...this.rules].sort((a, b) => a.holdoutMargin - b.holdoutMargin)[0]!;
      this.retire(weakest, now, `资本充足率强制收缩（Σ影响力 ${total.toFixed(3)} > κ×证据 ${capacity.toFixed(3)}）`);
      total -= this.influenceOf(weakest);
    }
  }

  /** 央行仪表盘（可观测口径） */
  bankView(): { rules: number; totalInfluence: number; evidenceBase: number; capacity: number; utilization: number; reserveRatio: number; forcedContractions: number } {
    const total = this.rules.reduce((s, r) => s + this.influenceOf(r), 0);
    const capacity = this.cfg.capitalKappa * this.evidenceBase;
    return {
      rules: this.rules.length,
      totalInfluence: Number(total.toFixed(4)),
      evidenceBase: this.evidenceBase,
      capacity: Number(capacity.toFixed(4)),
      utilization: capacity > 0 ? Number((total / capacity).toFixed(4)) : 0,
      reserveRatio: this.cfg.reserveRatio,
      forcedContractions: this.archive.filter((e) => e.kind === 'retire' && (e.reason ?? '').includes('资本充足率')).length,
    };
  }

  /**
   * 创世纪宪法审计（G2/G5 的最小交集）：两条定律的当期合规检查——
   * ① 准备金律：全部活跃规则 holdoutMargin ≥ reserveRatio；
   * ② 资本充足律：Σ影响力 ≤ κ × 证据基础。
   * 违规即 false（正常流程不应出现——这是宪法不是建议）。
   */
  constitutionAudit(): { holds: boolean; reserveHolds: boolean; capitalHolds: boolean; violations: string[] } {
    const violations: string[] = [];
    for (const r of this.rules) {
      if (r.holdoutMargin < this.cfg.reserveRatio) violations.push(`规则 ${r.id} 准备金 ${r.holdoutMargin.toFixed(3)} < ${this.cfg.reserveRatio}`);
    }
    const bank = this.bankView();
    if (bank.evidenceBase > 0 && bank.totalInfluence > bank.capacity) violations.push(`资本充足率越界 Σ${bank.totalInfluence} > κ×E ${bank.capacity}`);
    return { holds: violations.length === 0, reserveHolds: !violations.some((v) => v.includes('准备金')), capitalHolds: !violations.some((v) => v.includes('资本充足率')), violations };
  }

  /**
   * 持久乘数（调度消费口径）。查找优先级：精确上下文规则 > 全局规则 > 1
   * （更具体的结构支配更泛的结构）；规则臂 → 1 + min(maxBonus,
   * holdoutMargin)，其余臂 → 1。有界、无衰减、退役即回 1。
   */
  multiplierOf(modelId: string, taskType?: string): number {
    const arm = armOfModel(modelId);
    const contextual = taskType !== undefined ? this.rules.find((r) => r.taskContext === taskType) : undefined;
    const global = this.rules.find((r) => r.taskContext === undefined);
    const rule = contextual ?? global;
    if (!rule || rule.armId !== arm) return 1;
    return 1 + Math.min(this.cfg.maxBonus, Math.max(0, rule.holdoutMargin));
  }

  stats(): ConsolidatorStats {
    return {
      consolidations: this.consolidations,
      activeRules: this.activeRules(),
      archiveEntries: this.archive.length,
      chainIntact: this.verifyArchiveChain(),
      lastOutcome: this.lastOutcome ? { ...this.lastOutcome } : undefined,
    };
  }

  /** 档案链完整性（重算全链哈希） */
  verifyArchiveChain(): boolean {
    let prev = '0'.repeat(64);
    for (const e of this.archive) {
      if (hashEntry(prev, e) !== e.hash) return false;
      prev = e.hash;
    }
    return this.chainHead === prev;
  }

  /** 档案拷贝导出（审计用） */
  archiveLog(): ArchiveEntry[] {
    return this.archive.map((e) => ({ ...e }));
  }

  /** 可持久化快照（重启续档 / 审计篡改注入） */
  snapshotState(): { rules: PreferenceRule[]; archive: ArchiveEntry[]; chainHead: string; consolidations: number } {
    return {
      rules: this.activeRules(),
      archive: this.archiveLog(),
      chainHead: this.chainHead,
      consolidations: this.consolidations,
    };
  }

  /** 导入快照（整体替换；不触发落盘——调用方后续变更自然持久化） */
  restoreState(snap: { rules: PreferenceRule[]; archive: ArchiveEntry[]; chainHead?: string; consolidations?: number }): void {
    this.rules = snap.rules.map((r) => ({ ...r, evidence: cloneEvidence(r.evidence) }));
    this.archive = snap.archive.map((e) => ({ ...e }));
    this.chainHead = snap.chainHead ?? (this.archive.length > 0 ? this.archive[this.archive.length - 1]!.hash : '0'.repeat(64));
    this.consolidations = snap.consolidations ?? this.consolidations;
  }

  // ── 内部 ──

  /** 经验流来源（注入解耦：验证可用假源，桥接用 loop.eventLog） */
  private source: () => TaskOutcomeSignal[] = () => [];
  /** 注入经验流（构造后、使用前设置） */
  bindSource(source: () => TaskOutcomeSignal[]): void {
    this.source = source;
  }
  private sourceEvents(): TaskOutcomeSignal[] {
    return this.source();
  }

  private retire(rule: PreferenceRule, now: number, reason: string): void {
    this.rules = this.rules.filter((r) => r.id !== rule.id);
    this.append({ kind: 'retire', ruleId: rule.id, armId: rule.armId, at: now, reason });
  }

  private nextVersion(context: string | undefined, armId: string): number {
    return this.archive.filter((e) => e.kind === 'promote' && e.armId === armId && (e.taskContext ?? undefined) === context).length + 1;
  }

  private append(entry: Omit<ArchiveEntry, 'seq' | 'hash'>): void {
    const full: ArchiveEntry = { ...entry, seq: this.archive.length + 1, hash: '' };
    full.hash = hashEntry(this.chainHead, full);
    this.chainHead = full.hash;
    this.archive.push(full);
    this.lastOutcome = { kind: full.kind, ruleId: full.ruleId };
    this.persist();
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rules: this.rules, archive: this.archive, chainHead: this.chainHead, consolidations: this.consolidations }), 'utf8');
      renameSync(tmp, this.persistPath);
    } catch (err) {
      console.warn(`[plasticity-τ2] 档案落盘失败（${this.persistPath}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadFromDisk(): void {
    const p = this.persistPath!;
    if (!existsSync(p)) return;
    try {
      const snap = JSON.parse(readFileSync(p, 'utf8')) as { rules: PreferenceRule[]; archive: ArchiveEntry[]; chainHead: string; consolidations: number };
      if (!snap || !Array.isArray(snap.rules) || !Array.isArray(snap.archive)) throw new Error('快照结构不符');
      this.rules = snap.rules;
      this.archive = snap.archive;
      this.chainHead = snap.chainHead ?? '0'.repeat(64);
      this.consolidations = snap.consolidations ?? 0;
    } catch (err) {
      console.warn(`[plasticity-τ2] 档案加载失败，从零开始（${p}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────── 纯函数：结构检测 ───────────────────────────

interface ArmCounts {
  successes: number;
  failures: number;
}

/** 逐臂聚合节点级真值（无时间衰减——结构检测看长程） */
function armCounts(events: ReadonlyArray<TaskOutcomeSignal>): Map<string, ArmCounts> {
  const counts = new Map<string, ArmCounts>();
  for (const e of events) {
    for (const c of e.contributors) {
      const cur = counts.get(c.agentId) ?? { successes: 0, failures: 0 };
      if (c.success ?? e.success) cur.successes += 1;
      else cur.failures += 1;
      counts.set(c.agentId, cur);
    }
  }
  return counts;
}

/** 按成功率降序排列（样本不足者剔除） */
function rankArms(counts: Map<string, ArmCounts>, minSamples: number): Array<{ id: string; rate: number; n: number }> {
  const out: Array<{ id: string; rate: number; n: number }> = [];
  for (const [id, c] of counts) {
    const n = c.successes + c.failures;
    if (n < minSamples) continue;
    out.push({ id, rate: c.successes / n, n });
  }
  return out.sort((a, b) => b.rate - a.rate);
}

/** 保持集上 arm 相对全场次优臂的优势（样本不足 → undefined） */
function holdoutEdge(counts: Map<string, ArmCounts>, armId: string, minSamples: number): number | undefined {
  const ranking = rankArms(counts, minSamples);
  const mine = ranking.find((r) => r.id === armId);
  if (!mine) return undefined;
  const rest = ranking.filter((r) => r.id !== armId);
  if (rest.length === 0) return undefined;
  return mine.rate - rest[0]!.rate;
}

/** 两臂成功率之差的采样标准差（独立二项近似；样本缺失时 +∞ 保守） */
function marginSamplingSigma(counts: Map<string, ArmCounts>, a: string, b: string): number {
  const ca = counts.get(a);
  const cb = counts.get(b);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  const na = ca.successes + ca.failures;
  const nb = cb.successes + cb.failures;
  if (na < 1 || nb < 1) return Number.POSITIVE_INFINITY;
  const va = (ca.successes / na) * (ca.failures / na) / na;
  const vb = (cb.successes / nb) * (cb.failures / nb) / nb;
  return Math.sqrt(va + vb);
}

/** train 的全部子窗口中 a 均压过 b（符号稳定性，防单窗假象） */
function stableAcrossSubWindows(
  events: ReadonlyArray<TaskOutcomeSignal>,
  a: string,
  b: string,
  subWindows: number,
  minSamples: number,
): boolean {
  const size = Math.floor(events.length / subWindows);
  if (size < 1) return false;
  for (let w = 0; w < subWindows; w += 1) {
    const window = events.slice(w * size, w === subWindows - 1 ? events.length : (w + 1) * size);
    const counts = armCounts(window);
    const ra = counts.get(a);
    const rb = counts.get(b);
    if (!ra || !rb) return false;
    const na = ra.successes + ra.failures;
    const nb = rb.successes + rb.failures;
    // 子窗口内样本可低于全局门槛，但必须同量级可比（≥ 1/3 门槛）
    if (na < Math.max(2, Math.floor(minSamples / 3)) || nb < Math.max(2, Math.floor(minSamples / 3))) return false;
    if (ra.successes / na <= rb.successes / nb) return false;
  }
  return true;
}

/** modelId → 臂 id（与 symbiosis/bridge 的 modelAgentId 约定一致） */
function armOfModel(modelId: string): string {
  return `model:${modelId}`;
}

function cloneEvidence(ev: PreferenceRule['evidence']): PreferenceRule['evidence'] {
  return {
    trainEvents: ev.trainEvents,
    testEvents: ev.testEvents,
    trainCounts: Object.fromEntries(Object.entries(ev.trainCounts).map(([k, v]) => [k, [...v] as [number, number]])),
    testCounts: Object.fromEntries(Object.entries(ev.testCounts).map(([k, v]) => [k, [...v] as [number, number]])),
  };
}

function hashEntry(prevHash: string, e: Omit<ArchiveEntry, 'hash'>): string {
  return createHash('sha256')
    .update(`${prevHash}|${e.seq}|${e.kind}|${e.ruleId}|${e.armId}|${e.taskContext ?? ''}|${e.at}|${e.reason ?? ''}`)
    .digest('hex');
}
