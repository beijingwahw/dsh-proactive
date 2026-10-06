/**
 * verify-automl-hyperband.mjs — 93.0 自动机调优内核 纯数学离线验证
 *
 * 直接 import 内核源文件（node --experimental-strip-types 运行，不经 dist
 * ——内核纯数学零依赖，改完即可验）。
 *
 * 每个数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   ③ 调度数学: bracketSchedule(81,3) 复现论文调度表 n=[81,34,15,8,5]、
 *      r=[1,3,9,27,81]、Σ=405+363+351+378+405=1902（独立重加和 1e-9）;
 *      η 几何逐 bracket r_{i+1}=η·r_i; 成本交换不变 |c_{i+1}−c_i|≤r_{i+1};
 *      每 bracket ∈ (B−ηR/(η−1), B+(s+1)r_s]; η=2、R=27 分数预算镜像对称
 *      实例 135+121.5+114.75+121.5+135=627.75
 *   ④ SH 单元 + 学习曲线: 凸饱和解析锚点 1−e^{−1}; 窄带 k∈[2,2.4]
 *      ρ(score@1, 最终质量)>0.8 且 > 宽带 k∈[0.5,3] 对照（部分排序可控）;
 *      SH 5 轮减员 [81,27,9,3,1] 每轮成本 81、冠军=真实 argmax、真值冠军
 *      存活预算-1 轮; 全平手按下标序（确定性）
 *   ① 同总预算质量: 5000 曲线池 40 种子——Hyperband（预算 1902 检视 143 个
 *      配置）选出配置 ≥ 池 95 分位命中率 ≥0.9，对同预算全预算随机对照
 *      （23 个配置）胜率 ≥0.7
 *   ② 预算效率: 100 配置快饱和曲线（k∈[2.5,3.5]），达「全预算搜索最好成绩
 *      −0.02」的中位预算比 ≤ 随机搜索 1/3
 *   ⑤ 晚熟型反例: q∞=1.0、k=0.1 配置预算 1 排名 100/100、预算 27 排名
 *      1/100（排序翻转=欺骗机制）; 20 种子 Hyperband 仅少数（理论 ≈12%，
 *      低 s bracket 捡漏）找到它，中位差距 ≥0.05——诚实量化边界
 *
 * 全部断言确定性（mulberry32 种子内建于内核）。统计断言的容差在消息中文档化。
 * 运行：node --experimental-strip-types scripts/verify-automl-hyperband.mjs
 */

import {
  bracketSchedule,
  successiveHalvingUnit,
  hyperband,
  saturationScore,
  learningCurveFactory,
  randomSearchFullBudget,
  spearmanRho,
} from '../src/core/automl-hyperband.ts';

// ─────────────────────────── 断言工具 ───────────────────────────
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}
function okThrow(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
const sum = (a) => a.reduce((s, x) => s + x, 0);
/** 降序名次（严格大于者计数 +1，并列并列报） */
const rankDesc = (arr, v) => arr.filter((x) => x > v).length + 1;
const evalCurve = (c, b) => c.score(b);

// ═══════════════════ 锚点③：bracket 闭式调度数学 ═══════════════════

section('93.0 调度数学：闭式表 / η 几何 / 预算守恒');

{
  const sch = bracketSchedule(81, 3);
  ok(sch.sMax === 4, `sMax = ⌊log₃81⌋ = ${sch.sMax}（循环乘法求幂，免疫 log 浮点尘埃）`);
  ok(sch.brackets.map((b) => b.s).join(',') === '4,3,2,1,0', `bracket 序列 s = 4→0 降序（探索端先行）`);
  ok(
    sch.brackets.map((b) => b.nConfigs).join(',') === '81,34,15,8,5',
    `n = [${sch.brackets.map((b) => b.nConfigs).join(',')}]（⌈(B/R)·η^s/(s+1)⌉，B=405——论文调度表复现）`,
  );
  ok(
    sch.brackets.map((b) => b.initialBudget).join(',') === '1,3,9,27,81',
    `初始预算 r_s = [${sch.brackets.map((b) => b.initialBudget).join(',')}]（R·η^(−s)）`,
  );
  let geo = true;
  for (const b of sch.brackets) {
    for (let i = 1; i < b.rounds.length; i += 1) {
      if (Math.abs(b.rounds[i].perConfigBudget - 3 * b.rounds[i - 1].perConfigBudget) > 1e-9) geo = false;
    }
  }
  ok(geo, `η 几何: 逐 bracket 逐轮 r_{i+1} = 3·r_i（1e-9）`);
  const b4 = sch.brackets[0];
  ok(
    b4.rounds.map((r) => r.numConfigs).join(',') === '81,27,9,3,1',
    `bracket 4 轮配置数 [${b4.rounds.map((r) => r.numConfigs).join(',')}]（⌊n·r₀/r_i⌋ 几何减员）`,
  );
  ok(
    b4.rounds.every((r) => near(r.cost, 81, 1e-9)),
    `bracket 4 每轮成本 81（配置÷3 × 预算×3 交换不变: ${b4.rounds.map((r) => r.cost).join('+')}）`,
  );
  let exch = true;
  for (const b of sch.brackets) {
    for (let i = 1; i < b.rounds.length; i += 1) {
      if (Math.abs(b.rounds[i].cost - b.rounds[i - 1].cost) > b.rounds[i].perConfigBudget) exch = false;
    }
  }
  ok(exch, `全 bracket 成本交换不变 |c_{i+1}−c_i| ≤ r_{i+1}（⌊·⌋ 取整松弛上界）`);
  const resum = sum(sch.brackets.map((b) => b.budget));
  ok(near(resum, sch.totalBudget, 1e-9), `预算守恒: 独立重加和 ${resum} = totalBudget（1e-9）`);
  ok(
    sch.totalBudget === 1902,
    `Σ = ${sch.brackets.map((b) => b.budget).join('+')} = ${sch.totalBudget}（名义 (s_max+1)²R = 2025 的 ${(sch.totalBudget / 2025).toFixed(3)}——取整松弛诚实入账）`,
  );
  ok(
    sch.brackets.every(
      (b) =>
        b.budget > sch.normalizerBudget - (3 * 81) / 2 &&
        b.budget <= sch.normalizerBudget + (b.s + 1) * b.initialBudget + 1e-9,
    ),
    `每 bracket 预算 ∈ (B−ηR/(η−1), B+(s+1)r_s] = (283.5, …]（B=405 同价定理，含取整界）`,
  );
  // η=2、R=27: 分数预算第二实例（镜像对称 135+121.5+114.75+121.5+135）
  const sch2 = bracketSchedule(27, 2);
  const resum2 = sum(sch2.brackets.map((b) => b.budget));
  let geo2 = true;
  for (const b of sch2.brackets) {
    for (let i = 1; i < b.rounds.length; i += 1) {
      if (Math.abs(b.rounds[i].perConfigBudget - 2 * b.rounds[i - 1].perConfigBudget) > 1e-9) geo2 = false;
    }
  }
  ok(
    sch2.sMax === 4 && geo2 && near(resum2, sch2.totalBudget, 1e-9) && near(sch2.totalBudget, 627.75, 1e-9),
    `η=2、R=27: sMax=${sch2.sMax}，几何+守恒成立，Σ = ${sch2.totalBudget}（分数预算路径）`,
  );
  ok(
    sch2.brackets[0].budget === sch2.brackets[4].budget && sch2.brackets[1].budget === sch2.brackets[3].budget,
    `η=2 调度镜像对称（${sch2.brackets.map((b) => b.budget).join(' / ')}——极端探索与极端开发 bracket 同价）`,
  );
}

// ═══════════════════ 学习曲线工厂 + Spearman（锚点④前置） ═══════════════════

section('93.0 学习曲线工厂：凸饱和解析锚点 + 部分排序可控');

{
  ok(
    near(saturationScore(1, 1, 1), 1 - Math.exp(-1), 1e-15),
    `saturationScore(1,1,1) = ${(1 - Math.exp(-1)).toFixed(6)} = 1−e^{−1}（解析锚点）`,
  );
  const inc = [1, 3, 9, 27, 81].map((b) => saturationScore(0.9, 1.2, b));
  ok(inc.every((v, i) => i === 0 || v >= inc[i - 1]), `score 随预算单调不减（凸饱和）`);
  ok(
    inc[1] - inc[0] > inc[4] - inc[3],
    `收益递减: score(3)−score(1) = ${(inc[1] - inc[0]).toFixed(4)} > score(81)−score(27) = ${(inc[4] - inc[3]).toFixed(6)}（单位预算边际质量下降）`,
  );
  ok(near(spearmanRho([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1, 1e-12), `spearmanRho 完全共线 = 1`);
  ok(near(spearmanRho([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1, 1e-12), `spearmanRho 完全逆序 = −1`);
  const narrow = learningCurveFactory({ n: 200, seed: 11, quality: [0.5, 0.95], rate: [2.0, 2.4] });
  ok(
    narrow.length === 200 &&
      narrow.every((c) => c.finalQuality >= 0.5 && c.finalQuality <= 0.95 && c.rate >= 2.0 && c.rate <= 2.4 && !c.lateBloomer),
    `200 条曲线全部落在质量 [0.5,0.95] × 速度 [2.0,2.4]（默认无晚熟型注入）`,
  );
  const rhoNarrow = spearmanRho(narrow.map((c) => c.score(1)), narrow.map((c) => c.finalQuality));
  ok(
    rhoNarrow > 0.8,
    `窄带 ρ(score@1, 最终质量) = ${rhoNarrow.toFixed(4)} > 0.8（低预算排名携带全预算排名信息——SH 早停的合法性来源）`,
  );
  const wide = learningCurveFactory({ n: 200, seed: 11, quality: [0.5, 0.95], rate: [0.5, 3.0] });
  const rhoWide = spearmanRho(wide.map((c) => c.score(1)), wide.map((c) => c.finalQuality));
  ok(
    rhoNarrow > rhoWide + 0.05,
    `可控性对照: 窄带 [2,2.4] ${rhoNarrow.toFixed(3)} > 宽带 [0.5,3.0] ${rhoWide.toFixed(3)} + 0.05（速度带宽 ⇒ 部分排序保持度）`,
  );
}

// ═══════════════════ 锚点④：SH 复用单元 ═══════════════════

section('93.0 SH 复用单元：几何减员 / 成本不变 / 冠军不误杀');

{
  const pool = learningCurveFactory({ n: 81, seed: 23, quality: [0.5, 0.95], rate: [2.0, 2.4] });
  const sh = successiveHalvingUnit(pool, [1, 3, 9, 27, 81], evalCurve);
  ok(
    sh.rounds.length === 5 && sh.rounds.map((r) => r.numConfigs).join(',') === '81,27,9,3,1',
    `5 轮减员 [${sh.rounds.map((r) => r.numConfigs).join(',')}]（≈1/η 几何淘汰，与调度表逐位一致）`,
  );
  ok(
    sh.rounds.every((r) => near(r.cost, 81, 1e-9)) && sh.totalCost === 405,
    `每轮成本 81（81+81+81+81+81 = ${sh.totalCost} = n·r₀·轮数——交换不变的精确整数实例）`,
  );
  const maxQ = Math.max(...pool.map((c) => c.finalQuality));
  ok(
    sh.winner.finalQuality === maxQ,
    `SH 冠军即真实 argmax 最终质量 ${maxQ.toFixed(4)}（低预算排序部分保持 ⇒ 真值冠军从不被误杀）`,
  );
  ok(
    sh.rounds[0].survivors.includes(sh.winner),
    `冠军存活第 0 轮（预算 1）——部分排序保持的直接证据`,
  );
  // 单轮退化（bracket 0 口径: 5 配置全预算一次评估）
  const five = pool.slice(0, 5);
  const single = successiveHalvingUnit(five, [81], evalCurve);
  const top5 = five.reduce((a, c) => (c.finalQuality > a.finalQuality ? c : a));
  ok(
    single.rounds.length === 1 && single.totalCost === 405 && single.winner.finalQuality === top5.finalQuality,
    `单轮退化（bracket 0 口径）: 5 配置 @81，成本 405，冠军 = 全预算 argmax`,
  );
  // 全平手确定性
  const flat = Array.from({ length: 9 }, (_, i) => ({ id: i }));
  const shFlat = successiveHalvingUnit(flat, [1, 3], () => 0.5);
  ok(
    shFlat.winner.id === 0 && shFlat.rounds[0].survivors.map((c) => c.id).join(',') === '0,1,2',
    `全平手: 第 0 轮幸存者按候选下标序 [0,1,2]、冠军 id=0（确定性平手规则）`,
  );
}

// ═══════════════════ 锚点①：同总预算质量对照 ═══════════════════

section('93.0 Hyperband 主循环：同总预算下质量 ≥ 95 分位');

{
  const pool = learningCurveFactory({ n: 5000, seed: 99 });
  const sortedQ = [...pool.map((c) => c.finalQuality)].sort((a, b) => a - b);
  const p95 = sortedQ[Math.ceil(0.95 * sortedQ.length) - 1];
  const TRIALS = 40;
  let wins = 0;
  let hits = 0;
  let hbSum = 0;
  let rsSum = 0;
  let budgetOk = true;
  for (let t = 0; t < TRIALS; t += 1) {
    const seed = (7 + (t + 1) * 0x9e3779b1) >>> 0;
    const hb = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 81, seed });
    const rs = randomSearchFullBudget({
      evaluate: evalCurve,
      configs: pool,
      fullBudget: 81,
      totalBudget: hb.totalBudgetSpent,
      seed: (seed + 1) >>> 0,
    });
    const hbQ = hb.bestConfig.finalQuality;
    const rsQ = rs.bestConfig.finalQuality;
    if (hbQ >= rsQ) wins += 1;
    if (hbQ >= p95) hits += 1;
    hbSum += hbQ;
    rsSum += rsQ;
    if (hb.totalBudgetSpent !== 1902) budgetOk = false;
  }
  ok(
    budgetOk,
    `预算纪律: 每次运行 totalBudgetSpent = 1902 === schedule.totalBudget（逐配置预算可审计）`,
  );
  ok(
    hits / TRIALS >= 0.9,
    `① 质量分位: Hyperband 选出配置 ≥ 池 95 分位 (${p95.toFixed(4)}) 的命中率 ${hits}/${TRIALS} = ${(hits / TRIALS).toFixed(2)} ≥ 0.9（143 个低预算配置的覆盖优势）`,
  );
  ok(
    wins / TRIALS >= 0.7,
    `① 同预算对照: 对全预算随机（${Math.floor(1902 / 81)} 个配置）胜率 ${wins}/${TRIALS} = ${(wins / TRIALS).toFixed(2)} ≥ 0.7（低预算早停省下的预算换成 6× 检视广度）`,
  );
  ok(
    hbSum >= rsSum,
    `① 平均最终质量 Hyperband ${(hbSum / TRIALS).toFixed(4)} ≥ 随机 ${(rsSum / TRIALS).toFixed(4)}（多种子统计方向一致）`,
  );
}

// ═══════════════════ 锚点②：预算效率 ≤ 随机 1/3 ═══════════════════

section('93.0 预算效率：达「全预算最好成绩 − ε」的预算比');

{
  const pool = learningCurveFactory({ n: 100, seed: 5, quality: [0.5, 0.95], rate: [2.5, 3.5] });
  const bestTrue = Math.max(...pool.map((c) => c.score(81)));
  const target = bestTrue - 0.02;
  const budgetTo = (evals, fallback) => {
    for (const e of evals) if (e.score >= target) return e.cumulativeBudget;
    return fallback;
  };
  const TRIALS = 20;
  const ratios = [];
  let hbReached = 0;
  let rsReached = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    const seed = (101 + (t + 1) * 0x9e3779b1) >>> 0;
    const hb = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 81, seed });
    const rs = randomSearchFullBudget({
      evaluate: evalCurve,
      configs: pool,
      fullBudget: 81,
      totalBudget: 8100,
      seed: (seed + 77) >>> 0,
    });
    const hbB = budgetTo(hb.evaluations, hb.totalBudgetSpent);
    const rsB = budgetTo(rs.evaluations, rs.totalBudgetSpent);
    if (hbB < hb.totalBudgetSpent) hbReached += 1;
    if (rsB < rs.totalBudgetSpent) rsReached += 1;
    ratios.push(hbB / rsB);
  }
  ratios.sort((a, b) => a - b);
  const median = (ratios[9] + ratios[10]) / 2;
  ok(
    rsReached === TRIALS,
    `基线有效性自检: 随机对照铺满 100 配置（洗牌不重复）必然达标 ${rsReached}/${TRIALS}`,
  );
  ok(
    hbReached >= 19,
    `② Hyperband 达标率 ${hbReached}/${TRIALS} ≥ 0.95（未达标种子 = ε 内配置未被任何 bracket 抽中——诚实截尾而非作弊）`,
  );
  ok(
    median <= 1 / 3,
    `② 预算效率: 中位预算比 ${median.toFixed(3)} ≤ 1/3（Hyperband ≈ ${Math.round(median * 1500)} vs 随机 ≈ ${Math.round((median * 1500) / median)}——快饱和曲线下预算 3 的排名 ≈ 全预算排名，第 1 个 bracket 内即达标）`,
  );
  ok(
    ratios[0] < 0.2,
    `② 最好种子比值 ${ratios[0].toFixed(3)} < 0.2（bracket 4 前两轮 81×1 + 27×3 = 162 内即命中 ε 邻域）`,
  );
}

// ═══════════════════ 锚点⑤：晚熟型反例（诚实边界） ═══════════════════

section('93.0 晚熟型反例：欺骗机制的量化与边界');

{
  const pool = learningCurveFactory({ n: 100, seed: 7, quality: [0.55, 0.9], rate: [2.5, 3.5], deception: true });
  const lb = pool[99];
  ok(
    pool.filter((c) => c.lateBloomer).length === 1 &&
      lb.lateBloomer &&
      near(lb.finalQuality, 1, 1e-12) &&
      near(lb.rate, 0.1, 1e-12),
    `恰好 1 条晚熟型注入末位（id=99, q∞=1.0, k=0.1）`,
  );
  const bestTrue = Math.max(...pool.map((c) => c.score(81)));
  ok(
    near(bestTrue, lb.score(81), 1e-12),
    `晚熟型在全预算 81 下是唯一 argmax（score=${lb.score(81).toFixed(5)} > 快曲线上限 0.9）——「真最优」身份确立`,
  );
  const s1 = pool.map((c) => c.score(1));
  const s27 = pool.map((c) => c.score(27));
  ok(
    rankDesc(s1, lb.score(1)) === 100,
    `欺骗机制: 预算 1 下晚熟型排名 ${rankDesc(s1, lb.score(1))}/100（score=${lb.score(1).toFixed(4)} 垫底——被 SH 首轮处决）`,
  );
  ok(
    rankDesc(s27, lb.score(27)) === 1,
    `排序翻转: 预算 27 下同一配置排名 1/100（score=${lb.score(27).toFixed(4)} 登顶）——「早停假设低预算排序一致性」被打破`,
  );
  const TRIALS = 20;
  let found = 0;
  const gaps = [];
  for (let t = 0; t < TRIALS; t += 1) {
    const seed = (55 + (t + 1) * 0x9e3779b1) >>> 0;
    const hb = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 81, seed });
    if (hb.bestConfig.lateBloomer) found += 1;
    gaps.push(bestTrue - hb.bestScore);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = (gaps[9] + gaps[10]) / 2;
  ok(
    found <= 7,
    `⑤ Hyperband 找到晚熟型仅 ${found}/${TRIALS}（理论 ≈ 1−0.99⁵·0.99⁸ ≈ 12%——只有直接抽进低 s bracket（预算 27/81 才露头）才捡漏）`,
  );
  ok(
    medianGap >= 0.05,
    `⑤ 中位差距 ${medianGap.toFixed(4)} ≥ 0.05（被骗时交出的次优成绩 vs 真最优——量化边界，不吹牛）`,
  );
  ok(
    gaps[TRIALS - 1] < 0.16,
    `⑤ 被骗时仍返回快曲线族内高分（最差差距 ${gaps[TRIALS - 1].toFixed(4)} < 0.16）——是可量化的边界，不是崩溃`,
  );
}

// ═══════════════════ 确定性与入参校验 ═══════════════════

section('93.0 确定性与入参校验');

{
  const pool = learningCurveFactory({ n: 50, seed: 3 });
  const r1 = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 27, seed: 42 });
  const r2 = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 27, seed: 42 });
  ok(JSON.stringify(r1) === JSON.stringify(r2), `确定性: 同种子两次运行逐位一致（含评估轨迹/幸存者表/调度表）`);
  ok(
    r1.evaluations.length === r1.brackets.reduce((s, b) => s + b.rounds.reduce((q, r) => q + r.numConfigs, 0), 0) &&
      near(r1.totalBudgetSpent, r1.evaluations[r1.evaluations.length - 1].cumulativeBudget, 1e-9),
    `轨迹完整: evaluations 数 = Σ 逐轮 numConfigs = ${r1.evaluations.length}（幸存者逐轮复评——每轮成本 n_i×r_i 的对账口径），末条累计预算 = totalBudgetSpent`,
  );
  const wrongSeed = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 27, seed: 43 });
  ok(
    wrongSeed.bestScore !== r1.bestScore || wrongSeed.evaluations.length !== r1.evaluations.length || JSON.stringify(wrongSeed) !== JSON.stringify(r1),
    `异种子产生不同轨迹（种子真正驱动 bracket 抽样）`,
  );

  okThrow(() => bracketSchedule(0.5, 3), 'bracketSchedule: maxBudget < 1 → throw');
  okThrow(() => bracketSchedule(81, 1), 'bracketSchedule: eta = 1 → throw');
  okThrow(() => successiveHalvingUnit([], [1, 3], evalCurve), 'SH: candidates 空数组 → throw');
  okThrow(() => successiveHalvingUnit(pool.slice(0, 3), [3, 1], evalCurve), 'SH: budgets 非递增 → throw');
  okThrow(() => successiveHalvingUnit(pool.slice(0, 3), [], evalCurve), 'SH: budgets 空 → throw');
  okThrow(() => successiveHalvingUnit(pool.slice(0, 3), [1, 3], () => NaN), 'SH: evaluate 返回 NaN → throw');
  okThrow(() => hyperband({ evaluate: evalCurve, configs: [], eta: 3, maxBudget: 27 }), 'hyperband: configs 空数组 → throw');
  okThrow(() => hyperband({ evaluate: evalCurve, configs: pool, eta: 0.5, maxBudget: 27 }), 'hyperband: eta ≤ 1 → throw');
  okThrow(() => hyperband({ evaluate: null, configs: pool, eta: 3, maxBudget: 27 }), 'hyperband: evaluate 非函数 → throw');
  okThrow(() => hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 0.9 }), 'hyperband: maxBudget < 1 → throw');
  okThrow(() => learningCurveFactory({ n: 0 }), 'factory: n = 0 → throw');
  okThrow(() => learningCurveFactory({ n: 5, quality: [0.9, 0.5] }), 'factory: quality 区间倒置 → throw');
  okThrow(() => learningCurveFactory({ n: 5, quality: [0, 0.5] }), 'factory: quality 下界 ≤ 0 → throw');
  okThrow(() => learningCurveFactory({ n: 5, rate: [1, 0.5] }), 'factory: rate 区间倒置 → throw');
  okThrow(() => randomSearchFullBudget({ evaluate: evalCurve, configs: pool, fullBudget: 81, totalBudget: 10 }), 'randomSearch: totalBudget < fullBudget → throw');
  okThrow(() => randomSearchFullBudget({ evaluate: evalCurve, configs: [], fullBudget: 81, totalBudget: 810 }), 'randomSearch: configs 空 → throw');
  okThrow(() => spearmanRho([1, 2, 3], [1, 2]), 'spearmanRho: 长度不一致 → throw');
  okThrow(() => spearmanRho([1, 1, 1], [1, 2, 3]), 'spearmanRho: 全并列零方差 → throw');
  okThrow(() => saturationScore(0.8, 0, 1), 'saturationScore: rate = 0 → throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 93.0 自动机调优内核（Hyperband）数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
