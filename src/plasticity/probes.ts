/**
 * probes.ts — 遗忘探针（双系统可塑性 · 第一阶段）
 *
 * 定位：证伪标准②「遗忘受控」的工程化。快可塑（τ1）在线更新的每一步
 * 都可能把旧任务上的能力改坏——灾难性遗忘不是权重微调的专利，贝叶斯
 * 后验被对抗性结局污染同样会遗忘。探针 = 一组**冻结的历史事实**
 * （agentId → 结局真值），在每次更新批次前后对当前预测器评分：
 *
 *   score(预测器) = 冻结集上的对数损失 + 分桶校准误差（ECE）
 *
 * 批次后比批次前退化超过容差 → 上层回滚该批次（见 loop.ts 的
 * 事件溯源重建）。三个刻意的设计约束：
 *
 * 1. 探针集一旦冻结不可变——真值是「当时的世界」的采样，不是当前
 *    模型的意见；用当前模型的输出去更新探针 = 学生给自己出考卷。
 * 2. 度量是纯函数——score(forecaster) 不改任何状态，同一预测器
 *    重复评分逐位一致（回滚判定的确定性前提）。
 * 3. 对数损失裁剪到 [1e-6, 1-1e-6]——单探针损失有界，极端自信的
 *    错误不会把整批判成无穷大而失去分辨率。
 */

/** 单条冻结探针：某智能体上一次已结算的历史结局（真值，永不改写） */
export interface FrozenProbe {
  agentId: string;
  /** 历史真实结局（1 成功 / 0 失败） */
  truth: 0 | 1;
  /** 冻结时刻（审计用；不参与评分） */
  frozenAt: number;
}

/** 探针评分（纯函数度量的输出） */
export interface ProbeMetric {
  n: number;
  /** 冻结集平均对数损失（nats，越低越好） */
  logLoss: number;
  /** 分桶期望校准误差（|mean(p) − mean(y)| 按桶样本量加权，越低越好） */
  ece: number;
}

/** 退化判定容差 */
export interface ProbeTolerance {
  /** 对数损失容差（nats；批次后 − 批次前 > 此值判退化） */
  logLossTol: number;
  /** ECE 容差 */
  eceTol: number;
}

export const DEFAULT_PROBE_TOLERANCE: Readonly<ProbeTolerance> = {
  logLossTol: 0.02,
  eceTol: 0.05,
};

const P_CLIP = 1e-6;

/** 预测器：给定 agentId 返回当前模型对该智能体成功概率的估计 ∈ (0,1) */
export type ProbeForecaster = (agentId: string) => number;

/**
 * 冻结探针集。
 *
 * 用法：probeSet = new ForgettingProbeSet(records)；此后只读。
 * 评分时传入任意预测器（如 PlasticityLoop.predict）。
 */
export class ForgettingProbeSet {
  private readonly records: readonly FrozenProbe[];

  constructor(records: readonly FrozenProbe[]) {
    if (records.length === 0) throw new Error('ForgettingProbeSet: 探针集不能为空');
    const seen = new Set<string>();
    for (const r of records) {
      if (!r || typeof r.agentId !== 'string' || !r.agentId) throw new Error('ForgettingProbeSet: 探针须有非空 agentId');
      if (r.truth !== 0 && r.truth !== 1) throw new Error('ForgettingProbeSet: truth 须为 0 或 1');
      seen.add(r.agentId);
    }
    this.records = records;
  }

  size(): number {
    return this.records.length;
  }

  /** 覆盖的智能体数（探针集中在少数臂上时，退化信号更灵敏） */
  agentCount(): number {
    return new Set(this.records.map((r) => r.agentId)).size;
  }

  /** 拷贝导出（审计/复现实验用） */
  list(): FrozenProbe[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** 纯函数评分：冻结集上的 logLoss + ECE（不改预测器、不改自身） */
  score(forecaster: ProbeForecaster): ProbeMetric {
    let logLoss = 0;
    // 5 桶 ECE：按预测概率分桶，桶内比较预测均值与真实频率
    const bins = Array.from({ length: 5 }, () => ({ n: 0, pSum: 0, ySum: 0 }));
    for (const r of this.records) {
      const raw = forecaster(r.agentId);
      if (!Number.isFinite(raw)) throw new Error(`ForgettingProbeSet.score: 预测器对 ${r.agentId} 返回非有限值`);
      const p = Math.min(1 - P_CLIP, Math.max(P_CLIP, raw));
      logLoss += -(r.truth * Math.log(p) + (1 - r.truth) * Math.log(1 - p));
      const bin = Math.min(4, Math.max(0, Math.floor(p * 5)));
      bins[bin]!.n += 1;
      bins[bin]!.pSum += p;
      bins[bin]!.ySum += r.truth;
    }
    const n = this.records.length;
    let ece = 0;
    for (const b of bins) {
      if (b.n === 0) continue;
      ece += (b.n / n) * Math.abs(b.pSum / b.n - b.ySum / b.n);
    }
    return { n, logLoss: logLoss / n, ece };
  }
}

/** 批次前后评分对比与退化判定 */
export interface ProbeVerdict {
  before: ProbeMetric;
  after: ProbeMetric;
  logLossDelta: number;
  eceDelta: number;
  /** true = 退化超容差，该批次应被回滚 */
  degraded: boolean;
}

/**
 * 退化判定（纯函数）：对数损失或 ECE 任一超容差即判退化。
 * 刻意不含「改善也拒绝」的对称分支——改善是学习的目的，只有
 * 「改坏旧事实」才触发防御。
 */
export function probeVerdict(
  before: ProbeMetric,
  after: ProbeMetric,
  tol: Readonly<ProbeTolerance> = DEFAULT_PROBE_TOLERANCE,
): ProbeVerdict {
  const logLossDelta = after.logLoss - before.logLoss;
  const eceDelta = after.ece - before.ece;
  return {
    before,
    after,
    logLossDelta,
    eceDelta,
    degraded: logLossDelta > tol.logLossTol || eceDelta > tol.eceTol,
  };
}

/**
 * 从结局流冻结探针集（标准入口）：对已结算的历史信号按真实结局采样。
 * 支持节点级真值 override（同任务里逐贡献者的成败）——缺省回退任务级。
 * rng 显式注入——冻结是 irreversible 决策，种子进实验记录才可复现。
 */
export function freezeProbes(
  history: ReadonlyArray<{ contributors: ReadonlyArray<{ agentId: string; success?: boolean }>; success: boolean }>,
  targetSize: number,
  rand: () => number,
  now: number,
): ForgettingProbeSet {
  const flat: FrozenProbe[] = [];
  for (const h of history) {
    for (const c of h.contributors) {
      flat.push({ agentId: c.agentId, truth: (c.success ?? h.success) ? 1 : 0, frozenAt: now });
    }
  }
  if (flat.length === 0) throw new Error('freezeProbes: 历史流为空');
  if (flat.length <= targetSize) return new ForgettingProbeSet(flat);
  // 均匀无放回采样（Fisher–Yates 局部），保持确定性
  const pool = [...flat];
  const take: FrozenProbe[] = [];
  const need = targetSize;
  for (let i = 0; i < need; i += 1) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    take.push(pool[i]!);
  }
  return new ForgettingProbeSet(take);
}
