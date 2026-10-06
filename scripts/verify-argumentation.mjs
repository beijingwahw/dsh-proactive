/**
 * verify-argumentation.mjs — 81.0 论证内核（Dung 抽象论证框架）纯数学离线验证
 *
 * 三条互相独立的实现路线两两对账（不是「能跑」，是「算得对」）：
 *   grounded：不动点迭代（groundedExtension）vs 暴力 2^n 全子集扫描的
 *             完全集之交（bruteForceSemantics.completeIntersection）
 *   preferred/stable/complete：独立集 DFS 引擎 vs 2^n 全子集暴力直扫
 *   公共谓词（isAdmissible/isComplete/isStable，数组版）复核枚举结果
 *
 * 锚点（含规格勘误的如实标注）：
 *   ① 经典小框架：单自攻击（grounded ∅、四语义永不接受）/ 2-环
 *      a↔b（grounded ∅、偏好 {a}/{b}、稳定 {a}/{b}——注意：偶环**有**
 *      稳定外延，「无稳定」是奇环定理）/ 有向 3-环（grounded ∅、唯一
 *      偏好外延 ∅、无稳定——任何非空集都不可采纳）/ 互攻三角形
 *      a↔b↔c↔a（grounded ∅、3 偏好 + 3 稳定——规格「3 个偏好外延」
 *      锚点在此成立）/ 链 a→b→c（grounded={a,c}、iterations=3）
 *   ③ 复辩护：a↔b 且 c→b——a 被攻击但 b 被 a/c 双杀，a 复活；
 *      isAcceptable 重建辩护链（攻击者↦反击者）
 *   ④ 包含链：grounded ⊆ 每个完全集/偏好集/稳定外延；偏好⊆完全、
 *      稳定⊆偏好；每个完全集 ⊆ **某个**偏好集（字面「⊆每个偏好集」
 *      不成立——2-环反例 {a} ⊄ {b} 在脚本内演示）
 *
 * 全部断言确定性（随机实例用 mulberry32 种子生成，n ≤ 8、50 种子）。
 * 运行：node --experimental-strip-types scripts/verify-argumentation.mjs
 */

import {
  argumentFramework,
  randomFramework,
  isConflictFree,
  isAdmissible,
  isComplete,
  isStable,
  defends,
  isAcceptable,
  groundedExtension,
  preferredExtensions,
  stableExtensions,
  completeExtensions,
  bruteForceSemantics,
  acceptance,
  formatArgumentSet,
  MAX_ENUM_ARGUMENTS,
} from '../src/core/argumentation.ts';

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
/** 升序数组的逐位比对 */
function sameNumbers(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
/** 外延族比对（签名排序后逐集合比对——顺序无关） */
function sameFamily(a, b) {
  const sig = (list) =>
    list
      .map((s) => [...s].sort((x, y) => x - y).join(','))
      .sort()
      .join('|');
  return sig(a) === sig(b);
}
function subsetOf(a, b) {
  return a.every((x) => b.includes(x));
}

// ─────────────────────────── 公共构造 ───────────────────────────

/** 名字对构造：byName(['a','b'], [['a','b']]) = a 攻击 b */
const byName = (names, pairs) =>
  argumentFramework(names, pairs.map(([x, y]) => [names.indexOf(x), names.indexOf(y)]));
const setOf = (names, ...members) => members.map((m) => names.indexOf(m));

/** 经典 + 随机实例全集（④⑤ 复用；确定性） */
function allInstances() {
  const classics = [
    byName(['a'], [['a', 'a']]),
    byName(['a', 'b'], [['a', 'b'], ['b', 'a']]),
    byName(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]),
    byName(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b'], ['c', 'a'], ['a', 'c']]),
    byName(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]),
    byName(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['c', 'b']]),
  ];
  const randoms = [];
  for (let seed = 1; seed <= 50; seed += 1) {
    const n = 3 + (seed % 6); // 3..8
    const p = 0.2 + ((seed * 7) % 36) / 100; // 0.20..0.55
    randoms.push(randomFramework(n, p, seed, { selfAttacks: seed % 3 === 0 }));
  }
  return [...classics, ...randoms];
}

// ═══════════════════ ① 经典小框架 ═══════════════════

section('① 经典小框架逐一对照（Dung 1995 教科书锚点）');

{
  // ── 单自攻击 a→a ──
  const selfLoop = byName(['a'], [['a', 'a']]);
  const g1 = groundedExtension(selfLoop);
  ok(
    sameNumbers(g1.extension, []) && g1.iterations === 1,
    `单自攻击：grounded=∅、iterations=1（实际 ${formatArgumentSet(g1.extension, selfLoop)} × ${g1.iterations} 轮）`,
  );
  ok(
    !isConflictFree([0], selfLoop) && !isAdmissible([0], selfLoop),
    '单自攻击：{a} 连无冲突都不满足——自攻击者永不被任何外延接受',
  );
  ok(
    sameFamily(preferredExtensions(selfLoop), [[]]) &&
      sameFamily(completeExtensions(selfLoop), [[]]) &&
      stableExtensions(selfLoop).length === 0,
    '单自攻击：唯一偏好/完全外延是 ∅，无稳定外延',
  );
  ok(
    ['grounded', 'complete', 'preferred', 'stable'].every((s) => !acceptance(0, selfLoop, s).credulous),
    '单自攻击：a 在四种语义下均轻信不可接受',
  );

  // ── 2-环 a↔b ──
  const n2 = ['a', 'b'];
  const cyc2 = byName(n2, [['a', 'b'], ['b', 'a']]);
  const g2 = groundedExtension(cyc2);
  ok(
    sameNumbers(g2.extension, []) && g2.iterations === 1,
    '2-环：grounded=∅（F(∅)=∅——无人被空集防住）',
  );
  ok(
    sameFamily(preferredExtensions(cyc2), [setOf(n2, 'a'), setOf(n2, 'b')]),
    `2-环：偏好外延恰两个 {a}/{b}（实际 ${preferredExtensions(cyc2).map((e) => formatArgumentSet(e, cyc2)).join(' ')}）`,
  );
  ok(
    sameFamily(stableExtensions(cyc2), [setOf(n2, 'a'), setOf(n2, 'b')]),
    '2-环：稳定外延 {a}/{b}——【规格勘误】锚点原文「无稳定」不成立：偶环每个单边集都攻击对方即稳定；「无稳定」是奇环定理（见下一条 3-环）',
  );
  ok(
    sameFamily(completeExtensions(cyc2), [[], setOf(n2, 'a'), setOf(n2, 'b')]) &&
      sameNumbers(bruteForceSemantics(cyc2).completeIntersection, g2.extension),
    '2-环：完全外延 ∅/{a}/{b}，grounded = 完全集之交 = ∅（Dung 定理双法一致）',
  );
  const acc2 = acceptance(0, cyc2, 'preferred');
  const acc2s = acceptance(0, cyc2, 'stable');
  ok(
    acc2.credulous && !acc2.sceptical && acc2s.credulous && !acc2s.sceptical,
    `2-环：a 轻信接受（在 {a}）但疑信拒绝（不在 {b}）——多世界语义的本质（preferred ${acc2.memberships}/${acc2.extensionsCount}、stable ${acc2s.memberships}/${acc2s.extensionsCount}）`,
  );

  // ── 有向 3-环 a→b→c→a ──
  const n3 = ['a', 'b', 'c'];
  const cyc3 = byName(n3, [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  ok(
    sameNumbers(groundedExtension(cyc3).extension, []),
    '3-环：grounded=∅',
  );
  ok(
    stableExtensions(cyc3).length === 0,
    '3-环：无稳定外延（奇环定理——任何无冲突集都放走至少一个外部论证）',
  );
  ok(
    sameFamily(preferredExtensions(cyc3), [[]]) && sameFamily(completeExtensions(cyc3), [[]]),
    '3-环：唯一偏好/完全外延是 ∅——【规格勘误】有向 3-环任何非空集都不可采纳（单人防不住自己：a 的攻击者 c 不被 a 反击）；「grounded 空 + 3 个偏好外延」是互攻三角形的性质（下一条验证）',
  );
  const acc3 = acceptance(0, cyc3, 'stable');
  ok(
    acc3.extensionsCount === 0 && !acc3.credulous && !acc3.sceptical,
    '3-环：stable 族为空时疑信按 false 诚实返回（不做空洞真），extensionsCount=0 供分辨',
  );

  // ── 互攻三角形 a↔b, b↔c, c↔a ──
  const tri = byName(n3, [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b'], ['c', 'a'], ['a', 'c']]);
  ok(
    sameNumbers(groundedExtension(tri).extension, []),
    '互攻三角形：grounded=∅（全员被攻击、无人被 ∅ 防住）',
  );
  ok(
    sameFamily(preferredExtensions(tri), [setOf(n3, 'a'), setOf(n3, 'b'), setOf(n3, 'c')]),
    `互攻三角形：3 个偏好外延 {a}/{b}/{c}（实际 ${preferredExtensions(tri).map((e) => formatArgumentSet(e, tri)).join(' ')}）——「grounded 空 + 3 偏好外延」锚点在此成立（互攻击下人人自保）`,
  );
  ok(
    sameFamily(stableExtensions(tri), [setOf(n3, 'a'), setOf(n3, 'b'), setOf(n3, 'c')]),
    '互攻三角形：3 个稳定外延（每个单边集攻击另外两方）',
  );

  // ── 链 a→b→c ──
  const chain = byName(n3, [['a', 'b'], ['b', 'c']]);
  const gc = groundedExtension(chain);
  ok(
    sameNumbers(gc.extension, setOf(n3, 'a', 'c')) && gc.iterations === 3,
    `链 a→b→c：grounded={a,c}、iterations=3（实际 ${formatArgumentSet(gc.extension, chain)} × ${gc.iterations} 轮）`,
  );
  ok(
    gc.trace.length === 2 &&
      sameNumbers(gc.trace[0], setOf(n3, 'a')) &&
      sameNumbers(gc.trace[1], setOf(n3, 'c')),
    '链：不动点轨迹 F: ∅→{a}→{a,c}（c 由 a 间接受护——b 攻击 c 而 a 攻击 b；b 的攻击者 a 无人能反击）',
  );
  ok(
    sameFamily(stableExtensions(chain), [setOf(n3, 'a', 'c')]) &&
      sameFamily(preferredExtensions(chain), [setOf(n3, 'a', 'c')]) &&
      sameFamily(completeExtensions(chain), [setOf(n3, 'a', 'c')]),
    '链：{a,c} 唯一稳定 = 唯一偏好 = 唯一完全外延（三种语义合流）',
  );
  ok(
    !acceptance(1, chain, 'preferred').credulous && !acceptance(1, chain, 'grounded').credulous,
    '链：b 在偏好/基底语义下均不可接受（攻击者 a 无人能反击）',
  );
}

// ═══════════════════ ② 随机图 50 种子：三路线互证 ═══════════════════

section('② 随机图 50 种子（n≤8，含自攻击）：不动点迭代 vs 独立集 DFS vs 暴力枚举');

{
  let groundedMatch = 0;
  let preferredMatch = 0;
  let stableMatch = 0;
  let completeMatch = 0;
  let iterOk = 0;
  let subsetsOk = 0;
  let groundedComplete = 0;
  let publicPredOk = 0;
  let selfAttackInstances = 0;
  let stableNonEmptyInstances = 0;
  let totalPreferred = 0;
  let totalComplete = 0;

  for (let seed = 1; seed <= 50; seed += 1) {
    const n = 3 + (seed % 6);
    const p = 0.2 + ((seed * 7) % 36) / 100;
    const selfAttacks = seed % 3 === 0;
    const af = randomFramework(n, p, seed, { selfAttacks });
    const g = groundedExtension(af);
    const bf = bruteForceSemantics(af);
    const pref = preferredExtensions(af);
    const stab = stableExtensions(af);
    const comp = completeExtensions(af);

    if (sameNumbers([...g.extension], [...bf.completeIntersection])) groundedMatch += 1;
    if (sameFamily(pref, bf.preferredExtensions)) preferredMatch += 1;
    if (sameFamily(stab, bf.stableExtensions)) stableMatch += 1;
    if (sameFamily(comp, bf.completeExtensions)) completeMatch += 1;
    if (g.iterations >= 1 && g.iterations <= n + 1) iterOk += 1;
    if (bf.subsetsChecked === 2 ** n && bf.conflictFreeCount >= 1 && bf.admissibleCount >= 1) subsetsOk += 1;
    if (isComplete([...g.extension], af)) groundedComplete += 1;

    // 公共数组谓词复核掩码枚举结果（两套实现互证）
    let predOk = true;
    for (const e of bf.preferredExtensions) {
      if (!isAdmissible([...e], af) || !isComplete([...e], af)) predOk = false;
    }
    for (const e of bf.stableExtensions) {
      if (!isStable([...e], af) || !isConflictFree([...e], af)) predOk = false;
    }
    if (predOk) publicPredOk += 1;

    if (selfAttacks && af.attacks.some(([x, y]) => x === y)) selfAttackInstances += 1;
    if (bf.stableExtensions.length > 0) stableNonEmptyInstances += 1;
    totalPreferred += bf.preferredExtensions.length;
    totalComplete += bf.completeExtensions.length;
  }

  ok(
    groundedMatch === 50,
    `grounded 不动点迭代解 = 暴力枚举完全集之交：${groundedMatch}/50 逐位一致（Dung 定理的算法化验证）`,
  );
  ok(
    preferredMatch === 50 && stableMatch === 50 && completeMatch === 50,
    `独立集 DFS 引擎 = 2^n 全子集暴力：preferred ${preferredMatch}/50、stable ${stableMatch}/50、complete ${completeMatch}/50 全一致`,
  );
  ok(
    iterOk === 50 && subsetsOk === 50,
    `不动点迭代轮数 ∈ [1, n+1]：${iterOk}/50；暴力子集数 = 2^n 且 ∅ 恒可采纳：${subsetsOk}/50`,
  );
  ok(
    publicPredOk === 50 && groundedComplete === 50,
    `公共谓词复核：偏好=可采纳=完全、稳定=无冲突（${publicPredOk}/50）；grounded 自身是完全集（${groundedComplete}/50）`,
  );
  ok(
    selfAttackInstances >= 10 && stableNonEmptyInstances >= 5 && totalPreferred >= 50 && totalComplete >= 50,
    `覆盖面（非常数退化）：实含自攻击实例 ${selfAttackInstances} 个、非空稳定族 ${stableNonEmptyInstances} 个、累计偏好外延 ${totalPreferred} 个、完全外延 ${totalComplete} 个`,
  );
}

// ═══════════════════ ③ 复辩护（reinstatement） ═══════════════════

section('③ 复辩护：a↔b 且 c→b——b 被击败后 a 复活的辩护链');

{
  const names = ['a', 'b', 'c'];
  const af = byName(names, [['a', 'b'], ['b', 'a'], ['c', 'b']]);
  const g = groundedExtension(af);
  ok(
    sameNumbers([...g.extension], setOf(names, 'a', 'c')) && g.iterations === 3,
    `grounded={a,c}（F: ∅→{c}→{a,c}；实际 ${formatArgumentSet([...g.extension], af)} × ${g.iterations} 轮）`,
  );
  const chainA = isAcceptable(0, [...g.extension], af);
  ok(
    chainA.acceptable === true &&
      chainA.links.length === 1 &&
      chainA.links[0].attacker === 1 &&
      sameNumbers([...chainA.links[0].defenders], setOf(names, 'a', 'c')),
    `a 的辩护链：唯一攻击者 b，被 a 与 c 双重反击（b↦{${chainA.links[0].defenders.map((i) => names[i]).join(',')}}）——a 被攻击但复活`,
  );
  const chainB = isAcceptable(1, [...g.extension], af);
  ok(
    chainB.acceptable === false && chainB.links.every((l) => !l.defeated),
    `b 的辩护链：攻击者 ${chainB.links.map((l) => `${names[l.attacker]}↦[${l.defenders.map((i) => names[i]).join(',')}]`).join(' ')} 均无反击者——不可接受`,
  );
  ok(
    defends([...g.extension], 0, af) && !defends([...g.extension], 1, af),
    'defends 与 isAcceptable 同判（{a,c} 防住 a、防不住 b）',
  );
  ok(
    acceptance(0, af, 'grounded').credulous &&
      acceptance(2, af, 'grounded').sceptical &&
      !acceptance(1, af, 'grounded').credulous,
    '接受查询：a/c 在基底语义下接受（a 轻信且疑信——唯一外延收它）、b 拒绝',
  );
  ok(
    sameFamily(preferredExtensions(af), [setOf(names, 'a', 'c')]) &&
      sameFamily(stableExtensions(af), [setOf(names, 'a', 'c')]),
    '偏好/稳定外延唯一 {a,c}（b 被 a、c 双杀出局）',
  );
}

// ═══════════════════ ④ 语义包含链 ═══════════════════

section('④ 语义包含链：grounded ⊆ 完全集，完全 ⊆(某)偏好，稳定 ⊆ 偏好 ⊆ 完全');

{
  const instances = allInstances();
  let groundedBelowAll = 0;
  let preferredAreComplete = 0;
  let stableArePreferred = 0;
  let completeExtendable = 0;
  for (const af of instances) {
    const g = [...groundedExtension(af).extension];
    const comp = completeExtensions(af);
    const pref = preferredExtensions(af);
    const stab = stableExtensions(af);
    if (
      comp.every((e) => subsetOf(g, e)) &&
      pref.every((e) => subsetOf(g, e)) &&
      stab.every((e) => subsetOf(g, e))
    ) {
      groundedBelowAll += 1;
    }
    if (pref.every((e) => comp.some((c) => sameNumbers([...c], [...e])))) preferredAreComplete += 1;
    if (stab.every((e) => pref.some((p) => sameNumbers([...p], [...e])))) stableArePreferred += 1;
    if (comp.every((e) => pref.some((p) => subsetOf([...e], [...p])))) completeExtendable += 1;
  }
  const total = instances.length;
  ok(
    groundedBelowAll === total,
    `grounded ⊆ 每个完全集/偏好集/稳定外延：${groundedBelowAll}/${total} 实例全过（经典 6 + 随机 50）`,
  );
  ok(
    preferredAreComplete === total && stableArePreferred === total,
    `每个偏好外延是完全集、每个稳定外延是偏好外延（家族包含 stable ⊆ preferred ⊆ complete）：${preferredAreComplete}/${total}、${stableArePreferred}/${total}`,
  );
  ok(
    completeExtendable === total,
    `每个完全集 ⊆ 某个偏好集（可扩展性）：${completeExtendable}/${total}——【规格勘误】字面「每个完全集 ⊆ 每个偏好集」不成立，成立的是存在性版本`,
  );
  const n2 = ['a', 'b'];
  ok(
    !subsetOf(setOf(n2, 'a'), setOf(n2, 'b')),
    '字面反例演示：2-环完全外延 {a} ⊄ 偏好外延 {b}（不同偏好外延互不包含——多世界语义的本质，非内核缺陷）',
  );
}

// ═══════════════════ ⑤ skeptical / credulous 一致性 ═══════════════════

section('⑤ skeptical/credulous 接受查询一致性');

{
  const instances = allInstances();
  let logicOk = 0;
  let groundedUniqueOk = 0;
  let grPremise = 0;
  let grHolds = 0;
  let prefSceptPremise = 0;
  let prefSceptHolds = 0;
  let stCredPremise = 0;
  let stCredHolds = 0;
  let selfAttackTotal = 0;
  let selfAttackRejected = 0;

  for (const af of instances) {
    let instanceLogicOk = true;
    let instanceUniqueOk = true;
    for (let a = 0; a < af.size; a += 1) {
      const results = {};
      for (const sem of ['grounded', 'complete', 'preferred', 'stable']) {
        const r = acceptance(a, af, sem);
        results[sem] = r;
        if (r.credulous !== (r.memberships > 0)) instanceLogicOk = false;
        if (r.sceptical !== (r.extensionsCount > 0 && r.memberships === r.extensionsCount)) instanceLogicOk = false;
      }
      // grounded 外延唯一：疑信 = 轻信
      if (results.grounded.sceptical !== results.grounded.credulous) instanceUniqueOk = false;
      // grounded 接受 ⟹ 疑信偏好接受（grounded ⊆ 所有偏好外延；纯蕴涵统计：只数前提成立处）
      if (results.grounded.credulous) {
        grPremise += 1;
        if (results.preferred.sceptical) grHolds += 1;
      }
      // 稳定族非空时：疑信偏好 ⟹ 疑信稳定；轻信稳定 ⟹ 轻信偏好
      if (results.stable.extensionsCount > 0) {
        if (results.preferred.sceptical) {
          prefSceptPremise += 1;
          if (results.stable.sceptical) prefSceptHolds += 1;
        }
        if (results.stable.credulous) {
          stCredPremise += 1;
          if (results.preferred.credulous) stCredHolds += 1;
        }
      }
      // 自攻击者永不轻信接受
      if (af.attackersOf[a].includes(a)) {
        selfAttackTotal += 1;
        if (['complete', 'preferred', 'stable'].every((s) => !results[s].credulous)) selfAttackRejected += 1;
      }
    }
    if (instanceLogicOk) logicOk += 1;
    if (instanceUniqueOk) groundedUniqueOk += 1;
  }
  const total = instances.length;
  ok(
    logicOk === total,
    `布尔自洽：credulous ⟺ memberships>0、sceptical ⟺ 族非空 ∧ memberships=count：${logicOk}/${total} 实例（全部论证 × 四种语义）`,
  );
  ok(
    groundedUniqueOk === total,
    `grounded 外延唯一 ⟹ 疑信 = 轻信：${groundedUniqueOk}/${total}`,
  );
  ok(
    grPremise > 0 && grHolds === grPremise,
    `grounded 接受 ⟹ 疑信偏好接受：${grHolds}/${grPremise} 前提成立处全过`,
  );
  ok(
    (prefSceptPremise === 0 || prefSceptHolds === prefSceptPremise) &&
      (stCredPremise === 0 || stCredHolds === stCredPremise),
    `稳定族非空时：疑信偏好 ⟹ 疑信稳定（${prefSceptHolds}/${prefSceptPremise}）、轻信稳定 ⟹ 轻信偏好（${stCredHolds}/${stCredPremise}）`,
  );
  ok(
    selfAttackTotal >= 3 && selfAttackRejected === selfAttackTotal,
    `自攻击者在 complete/preferred/stable 语义下均轻信不可接受：${selfAttackRejected}/${selfAttackTotal}（含单自攻击经典框架）`,
  );
}

// ═══════════════════ ⑥ 入参校验 / 护栏 / 确定性 ═══════════════════

section('⑥ 入参校验显式抛错、枚举护栏与确定性');

{
  ok(throws(() => argumentFramework(['a', 'a'], [])), 'argumentFramework：论证重名抛错');
  ok(throws(() => argumentFramework(['a'], [[0, 1]])), 'argumentFramework：攻击下标越界抛错');
  ok(throws(() => argumentFramework([''], [])), 'argumentFramework：空名抛错');
  ok(throws(() => isAdmissible([3], byName(['a', 'b'], [['a', 'b']]))), 'isAdmissible：候选集下标越界抛错');
  ok(throws(() => isAcceptable(5, [0], byName(['a'], []))), 'isAcceptable：论证下标越界抛错');
  ok(throws(() => acceptance(0, byName(['a'], []), 'nonsense')), 'acceptance：未知语义字符串抛错');

  const big = argumentFramework(
    Array.from({ length: MAX_ENUM_ARGUMENTS + 1 }, (_, i) => `x${i}`),
    [],
  );
  ok(
    throws(() => preferredExtensions(big)) &&
      throws(() => stableExtensions(big)) &&
      throws(() => bruteForceSemantics(big)),
    `枚举语义护栏：${MAX_ENUM_ARGUMENTS + 1} 论证框架上 preferred/stable/bruteForce 抛错（外延族 2^n 指数）`,
  );
  ok(
    groundedExtension(big).extension.length === MAX_ENUM_ARGUMENTS + 1,
    '同框架 groundedExtension 正常返回（多项式路径不受护栏限制；无攻击时全员入基底外延）',
  );

  const r1 = randomFramework(6, 0.4, 7, { selfAttacks: true });
  const r2 = randomFramework(6, 0.4, 7, { selfAttacks: true });
  ok(
    JSON.stringify(r1.attacks) === JSON.stringify(r2.attacks),
    'randomFramework 同种子同攻击表（mulberry32 确定性）',
  );
  ok(
    JSON.stringify(preferredExtensions(r1)) === JSON.stringify(preferredExtensions(r2)) &&
      JSON.stringify(groundedExtension(r1)) === JSON.stringify(groundedExtension(r2)),
    '同种子框架的外延族逐位复现（含 attacks/trace 序列化一致）',
  );

  const empty = argumentFramework([], []);
  const ge = groundedExtension(empty);
  ok(
    ge.extension.length === 0 && ge.iterations === 1 && bruteForceSemantics(empty).subsetsChecked === 1,
    '空框架边界：grounded=∅ × 1 轮、暴力扫描恰 1 个子集（诚实处理零元边界）',
  );
  ok(
    near(groundedExtension(byName(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])).iterations, 3, 0),
    '链框架迭代轮数精确 = 3（near 容差 0——整数值对照）',
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.error('❌ 论证内核验证存在失败断言');
}
process.exitCode = failed > 0 ? 1 : 0;
