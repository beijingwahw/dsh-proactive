/**
 * evidence.ts — 统一证据内核（项目 3.0「全层证据统一 + 自知之明」基石）
 *
 * R5 第五轮进化（内核世界性进化·统计推断组）：
 * - 数学：bayesFactor —— Beta-Binomial 边际似然的**闭式贝叶斯因子**
 *   （H1: p ~ Beta(1,1) 广义假设 vs H0: p = p0 点零假设），
 *   logBF₁₀ = lnB(s+1, f+1) − [s·ln p0 + f·ln(1−p0)]；附 Kass–Raftery
 *   (1995) 解释分级（negligible/moderate/strong/very strong）——证据语言
 *   从「下界是多少」升维到「证据支持哪个假设、有多强」。
 * - 数学：synthesizeEvidence —— 多源证据的**精确共轭合成闭式**：
 *   Beta 族是指数族，合并 k 条独立证据流 = 自然参数（衰减后的
 *   ws/wf 计数）求和。内部按 (lastDecayedAt, ws, wf) 规范排序，
 *   使合成结果**逐位置换不变**（加法交换律的浮点级兑现）。
 * - 数值稳健：logGamma（Lanczos g=7 / 9 项系数，反射公式护 (0,0.5)）+
 *   logBeta —— 全程对数域，ws/wf 到 1e8 量级也不溢出（直接乘
 *   Γ(s+1)Γ(f+1) 在 s ≳ 170 就溢出双精度）；巨大 BF 以 log10Bf 口径
 *   返回，bf10 饱和到 ±Infinity 也不失信息。
 *
 * 项目级质升前的问题（勘察结论）：
 * - 时间衰减 / Wilson 下界 / Beta 后验只服务于模型画像（ModelTaskStats）一层；
 *   蒸馏策略、语义记忆、程序记忆仍用裸 confidence + 裸计数，检索排序裸置信度；
 * - 沙盒校准读裸 avgQualityScore / totalCalls，旧证据与漂移无法感知；
 * - 各层统计口径（confidence / posteriorMean / wilsonLower）混用互不可比。
 *
 * 本内核把同一套统计语言铺到所有记忆层：
 * - wilsonLowerBound：小样本保守的置信下界（排序与校准的统一度量）
 * - decayFactor：时间衰减（30 天半衰期，旧证据自然让位）
 * - MemoryEvidence：可持久化的时间加权 Beta 证据（ws/wf/lastDecayedAt）
 * - observeEvidence：写入式观测（惰性衰减 + 累积，读取零开销）
 * - readEvidence：读取式视图（纯函数衰减，不回写）
 * - evidenceRankScore：证据化排序分（confidence × Wilson 下界等权混合；
 *   无证据时回退裸 confidence，行为与升级前逐位一致——并行旁路设计）
 *
 * 兼容性：旧格式记忆无 evidence 字段 → 首次观测时从裸计数按 0.5 折价初始化
 * （与模型画像 legacy 回退语义一致），confidence 更新公式保持不变。
 */

/** Wilson 置信下界（纯函数，全部层共享的统一不确定性度量） */
export function wilsonLowerBound(successes: number, failures: number, z = 1.96): number {
  const n = successes + failures;
  if (n <= 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Wilson 置信上界（4.0：金丝雀/回归判定的「乐观边界」）
 *
 * 用途：只有当乐观边界也低于期望阈值时才确认劣化——单侧噪声不触发回滚。
 * 如 7/10 成功（raw 0.7 < 期望 0.85-0.1）但上界 0.89 ≥ 0.75 → 未确认，继续观察；
 * 0/5 全败上界 0.43 << 0.75 → 立即确认。
 */
export function wilsonUpperBound(successes: number, failures: number, z = 1.96): number {
  const n = successes + failures;
  if (n <= 0) return 1;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / denom);
}

/** 证据时间衰减半衰期（天）——30 天前的证据权重折半 */
export const DECAY_HALF_LIFE_DAYS = 30;
/** Beta 先验强度（均匀先验 Beta(1,1)） */
export const BAYES_PRIOR_STRENGTH = 1;
/** 证据参与排序/校准的最小有效样本量（低于此值回退裸 confidence） */
export const EVIDENCE_MIN_SAMPLES = 3;
/** 旧格式（无时间信息）证据折价系数 */
export const LEGACY_EVIDENCE_DISCOUNT = 0.5;
/** 排序混合权重：confidence 与 Wilson 下界各占一半 */
export const EVIDENCE_RANK_BLEND = 0.5;

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/** 时间衰减因子：0.5 ^ (elapsedMs / halfLife），未来时间不放大 */
export function decayFactor(elapsedMs: number, halfLifeDays: number = DECAY_HALF_LIFE_DAYS): number {
  if (elapsedMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / (halfLifeDays * DAY_MS));
}

/**
 * 可持久化的时间加权 Beta 证据
 *
 * 挂载于 DistilledStrategy / SemanticMemory / ProceduralMemory 的可选字段
 * evidence（并行旁路：不改变宿主实体的 confidence 语义）。
 */
export interface MemoryEvidence {
  /** 时间加权成功证据（半衰期 30 天惰性累积） */
  weightedSuccesses: number;
  /** 时间加权失败证据 */
  weightedFailures: number;
  /** 幂等衰减基准（上次证据衰减时间戳） */
  lastDecayedAt: number;
}

/** 从裸计数初始化证据（无时间信息 → 0.5 折价，与模型画像 legacy 回退一致） */
export function initEvidence(successes: number, total: number, at: number): MemoryEvidence {
  const failures = Math.max(0, total - Math.max(0, successes));
  return {
    weightedSuccesses: Math.max(0, successes) * LEGACY_EVIDENCE_DISCOUNT,
    weightedFailures: failures * LEGACY_EVIDENCE_DISCOUNT,
    lastDecayedAt: at,
  };
}

/** 写入式观测：先惰性衰减到 now，再计入新证据（原地更新，读取零开销） */
export function observeEvidence(evidence: MemoryEvidence, success: boolean, now: number): void {
  const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
  evidence.weightedSuccesses *= decay;
  evidence.weightedFailures *= decay;
  if (success) evidence.weightedSuccesses += 1;
  else evidence.weightedFailures += 1;
  evidence.lastDecayedAt = now;
}

/**
 * 加权观测（4.0：连续收益 0~1 的证据化，如进化引擎的 outcome reward）
 *
 * 把一次 value∈[0,1] 的连续观测拆为 success=value / failure=1-value 计入——
 * 布鲁厄姆/冯·诺依曼式分数观测：连续信号无需离散化即可进入统一 Beta 证据，
 * 时间衰减语义与 observeEvidence 完全一致。
 */
export function observeWeightedEvidence(evidence: MemoryEvidence, value: number, now: number): void {
  const v = Math.max(0, Math.min(1, value));
  const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
  evidence.weightedSuccesses *= decay;
  evidence.weightedFailures *= decay;
  evidence.weightedSuccesses += v;
  evidence.weightedFailures += 1 - v;
  evidence.lastDecayedAt = now;
}

/** 证据读取视图（Beta 后验 + Wilson 下界 + 有效样本量） */
export interface EvidenceView {
  weightedSuccesses: number;
  weightedFailures: number;
  effectiveSamples: number;
  posteriorMean: number;
  wilsonLower: number;
}

/** 读取式视图：纯函数衰减（不回写），供排序/报告/沙盒校准消费 */
export function readEvidence(evidence: MemoryEvidence, now: number): EvidenceView {
  const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
  const ws = evidence.weightedSuccesses * decay;
  const wf = evidence.weightedFailures * decay;
  const alpha = ws + BAYES_PRIOR_STRENGTH;
  const beta = wf + BAYES_PRIOR_STRENGTH;
  return {
    weightedSuccesses: ws,
    weightedFailures: wf,
    effectiveSamples: ws + wf,
    posteriorMean: alpha / (alpha + beta),
    wilsonLower: wilsonLowerBound(ws, wf),
  };
}

/**
 * 证据化排序分：confidence 与 Wilson 下界等权混合
 *
 * 质变：0.95 置信度但仅 3 次应用（下界 ≈ 0.44）的记忆，排序分 ≈ 0.70；
 * 0.85 置信度且 50 次应用 48 成（下界 ≈ 0.79）的记忆，排序分 ≈ 0.82——
 * 小样本高置信不再压过大样本稳置信。
 *
 * 兼容：无证据或有效样本 < EVIDENCE_MIN_SAMPLES → 原样返回 confidence
 * （与升级前排序行为逐位一致，既有消费方零感知）。
 */
export function evidenceRankScore(confidence: number, evidence: MemoryEvidence | undefined, now: number): number {
  if (!evidence) return confidence;
  const view = readEvidence(evidence, now);
  if (view.effectiveSamples < EVIDENCE_MIN_SAMPLES) return confidence;
  return EVIDENCE_RANK_BLEND * confidence + (1 - EVIDENCE_RANK_BLEND) * view.wilsonLower;
}

// ───────────────────── R5：对数域特殊函数（数值稳健基座） ─────────────────────

/** Lanczos 近似系数（g = 7，9 项；双精度下相对误差 ~1e-13） */
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const LANCZOS_GAMMA = 7;
/** ln(2π) 常量（Lanczos 公式首项） */
const LN_TWO_PI = Math.log(2 * Math.PI);

/**
 * 对数伽马函数 ln Γ(x)（Lanczos g=7 近似 + x<0.5 反射公式）。
 *
 * 数值稳健：Γ(x) 本身在 x ≳ 171 溢出双精度，ln Γ 在 x ≤ 1e308 全程
 * 可表示——贝叶斯因子的边际似然在大计数证据下只有对数域算得动。
 */
export function logGamma(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x <= 0) return Number.NaN; // 伽马函数非正整数处为极点
  if (x < 0.5) {
    // 反射公式：Γ(x)Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = LANCZOS_COEFFICIENTS[0]!;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    series += LANCZOS_COEFFICIENTS[i]! / (z + i);
  }
  const t = z + LANCZOS_GAMMA + 0.5;
  return 0.5 * LN_TWO_PI + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** 对数 Beta 函数 ln B(a, b) = lnΓ(a) + lnΓ(b) − lnΓ(a+b)（对数域，无溢出） */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

// ───────────────────── R5：贝叶斯因子（闭式 + 解释分级） ─────────────────────

/** Kass–Raftery (1995) 贝叶斯因子解释分级 */
export type BayesFactorGrade = 'negligible' | 'moderate' | 'strong' | 'very strong';

/** 贝叶斯因子读取视图 */
export interface BayesFactorResult {
  /** BF₁₀ = P(数据|H1)/P(数据|H0)；>1 支持广义假设 H1，<1 支持点零假设 H0 */
  bf10: number;
  /** log₁₀ BF₁₀（巨大/极小计数下唯一无溢出的口径；bf10 饱和时仍精确） */
  log10Bf: number;
  /** 证据强势方向 */
  favors: 'h1' | 'h0';
  /** 强势方向的量级分级（Kass–Raftery：3 / 20 / 150） */
  grade: BayesFactorGrade;
  /** 点零假设的概率值 p0 */
  nullProbability: number;
  /** 可读解释 */
  interpretation: string;
}

/** Kass–Raftery 分级阈值（BF 量级：3 / 20 / 150） */
export const BAYES_FACTOR_THRESHOLDS: Readonly<{ moderate: number; strong: number; veryStrong: number }> = {
  moderate: 3,
  strong: 20,
  veryStrong: 150,
};

/**
 * 闭式贝叶斯因子（Beta-Binomial 边际似然比）。
 *
 * H1: p ~ Beta(1,1)（均匀先验，与内核 BAYES_PRIOR_STRENGTH=1 同源）；
 * H0: p = p0（点零假设，缺省 0.5「五五开」）。
 *
 *   P(数据|H1) = B(s+1, f+1) / B(1,1) = B(s+1, f+1)
 *   P(数据|H0) = p0^s · (1−p0)^f
 *   logBF₁₀   = lnB(s+1, f+1) − [s·ln p0 + f·ln(1−p0)]
 *
 * 对数域全程无溢出：s=f=1e8 时 log10Bf 仍精确（bf10 为 ±Infinity）。
 * 分级按强势一侧的 BF 量级（Kass & Raftery 1995：≥3 moderate、
 * ≥20 strong、≥150 very strong）。
 */
export function bayesFactor(successes: number, failures: number, nullProbability = 0.5): BayesFactorResult {
  const s = Math.max(0, successes);
  const f = Math.max(0, failures);
  const p0 = Math.min(1 - 1e-12, Math.max(1e-12, nullProbability));
  // 均匀先验下边际似然 = B(s+1, f+1)（B(1,1)=1）
  const logBf10 = logBeta(s + 1, f + 1) - (s * Math.log(p0) + f * Math.log(1 - p0));
  const log10 = logBf10 / Math.LN10;
  const bf10 = log10 >= 308 ? Number.POSITIVE_INFINITY : log10 <= -308 ? 0 : Math.pow(10, log10);
  const favors: 'h1' | 'h0' = logBf10 >= 0 ? 'h1' : 'h0';
  const magnitude = Math.abs(log10); // 强势一侧量级的 log₁₀ 口径
  const t = BAYES_FACTOR_THRESHOLDS;
  const grade: BayesFactorGrade =
    magnitude >= Math.log10(t.veryStrong)
      ? 'very strong'
      : magnitude >= Math.log10(t.strong)
        ? 'strong'
        : magnitude >= Math.log10(t.moderate)
          ? 'moderate'
          : 'negligible';
  const interpretation =
    s + f === 0
      ? '零证据：BF₁₀ = 1（两个假设下空数据同样可能，无从判别）'
      : `BF₁₀=${formatBf(bf10)}（log₁₀=${log10.toFixed(2)}）：证据${favors === 'h1' ? '支持广义假设 H1' : '反向支持点零假设 H0（p=' + p0 + '）'}，强度 ${grade}（s=${s}/f=${f}）`;
  return { bf10, log10Bf: log10, favors, grade, nullProbability: p0, interpretation };
}

function formatBf(bf10: number): string {
  if (!Number.isFinite(bf10)) return bf10 > 0 ? 'Overflow(+∞)' : '0';
  return bf10 >= 1e6 ? bf10.toExponential(2) : bf10.toFixed(2);
}

// ───────────────────── R5：多源证据精确合成（共轭闭式） ─────────────────────

/**
 * 多源证据合成（Beta 共轭闭式，逐位置换不变）。
 *
 * Beta 族是指数族：k 条独立证据流在相同时刻 now 的合成 = 各流衰减到
 * now 后的自然参数求和（weightedSuccesses/weightedFailures 直接相加），
 * 再走同一条 Beta(1,1) 后验 + Wilson 下界读取管线——**精确**共轭合成，
 * 无信息丢失、无近似。
 *
 * 确定性：内部按 (lastDecayedAt, weightedSuccesses, weightedFailures)
 * 规范排序后求和——置换输入顺序输出逐位一致（浮点加法交换律的兑现）。
 * 空输入：零证据视图（posteriorMean = 先验均值 0.5，wilsonLower = 0）。
 */
export function synthesizeEvidence(parts: readonly MemoryEvidence[], now: number): EvidenceView {
  if (parts.length === 0) {
    return {
      weightedSuccesses: 0,
      weightedFailures: 0,
      effectiveSamples: 0,
      posteriorMean: BAYES_PRIOR_STRENGTH / (2 * BAYES_PRIOR_STRENGTH),
      wilsonLower: wilsonLowerBound(0, 0),
    };
  }
  const canonical = [...parts].sort(
    (a, b) =>
      a.lastDecayedAt - b.lastDecayedAt || a.weightedSuccesses - b.weightedSuccesses || a.weightedFailures - b.weightedFailures,
  );
  let ws = 0;
  let wf = 0;
  for (const part of canonical) {
    const view = readEvidence(part, now); // 单次衰减读取，避免重复计算
    ws += view.weightedSuccesses;
    wf += view.weightedFailures;
  }
  const alpha = ws + BAYES_PRIOR_STRENGTH;
  const beta = wf + BAYES_PRIOR_STRENGTH;
  return {
    weightedSuccesses: ws,
    weightedFailures: wf,
    effectiveSamples: ws + wf,
    posteriorMean: alpha / (alpha + beta),
    wilsonLower: wilsonLowerBound(ws, wf),
  };
}
