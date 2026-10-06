/**
 * verify-stable-matching.mjs — 61.0 稳定匹配内核纯数学离线验证
 *
 * 六个验证锚点（不是「能跑」，是「算得对」）:
 *   ① 教科书例对照: 3×3 双稳态例（手工 GS 双向逐轮推演已知解）+ 4×4 块对角
 *        格钻石（恰 4 个稳定匹配、中间两个不可比）+ 唯一稳定匹配退化例
 *   ② 随机稳定性: 种子化 n=6~8 × 60 实例，双向 GS 输出全部通过 isStable
 *        （无阻挡对）、完美匹配、求婚次数 ≤ n²、逆映射一致
 *   ③ 格序: 求婚方最优 ≽ 接收方最优（求婚方逐分量名次不降），接收方反向
 *        同时成立（顶=求婚方最优 ∧ 底=接收方最优，Conway 格定理）
 *   ④ 全体稳定匹配枚举: 枚举集内每个匹配都稳定、两 GS 极值都在集内、无重复
 *   ⑤ DSIC（Gale–Sotomayor）: 550 次随机完整排列谎报，求婚方真实名次
 *        无一改善（平局或变差）
 *   ⑥ TTC: 2 人互换/自留+互换/三方大圈/双圈+尾巴文献结构例精确对照 +
 *        核成员检查（弱核/强核双口径）+ 强核单点性（枚举一切 n! 分配:
 *        强核中恰 1 个 = TTC 输出，Roth–Postlewaite；弱核可多点）
 *   ⑦ 入参校验: 非严格偏好/未知名/整数样式名/非单射/超界枚举 → 显式 throw
 *
 * 全部断言确定性（mulberry32 种子来自内核导出）。运行:
 *   node --experimental-strip-types scripts/verify-stable-matching.mjs
 */

import {
  deferredAcceptance,
  latticeExtremes,
  allStableMatchings,
  isStable,
  topTradingCycles,
  inCore,
  randomMatchingProblem,
  randomHousingMarket,
  mulberry32,
} from '../src/core/stable-matching.ts';

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

/** 匹配规范化为可比较字符串（键排序） */
function canon(m) {
  return Object.keys(m)
    .sort()
    .map((k) => `${k}:${m[k]}`)
    .join(',');
}
function invert(m) {
  const r = {};
  for (const [k, v] of Object.entries(m)) r[v] = k;
  return r;
}
function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
function forEachPermutation(arr, fn) {
  const a = [...arr];
  const rec = (k) => {
    if (k === a.length) {
      fn([...a]);
      return;
    }
    for (let i = k; i < a.length; i += 1) {
      [a[k], a[i]] = [a[i], a[k]];
      rec(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  rec(0);
}

// ═══════════════════ ① 教科书例对照 ═══════════════════

section('61.0-① 教科书例: 3×3 双稳态 + 4×4 格钻石 + 唯一退化例');

{
  // 3×3 手工推演例（求婚方 m1/m2/m3，接收方 w1/w2/w3）:
  //   求婚方发起: 第1轮 m1→w2 握、m2→w1 握、m3→w1 拒（w1 更爱 m2）；
  //   第2轮 m3→w3 握 → {(m1,w2),(m2,w1),(m3,w3)}（唯一求婚方最优）。
  //   接收方发起: 第1轮 w3→m1 被拒（m1 已握 rank1 的 w1）；
  //   第2轮 w3→m2 拒；第3轮 w3→m3 握 → {(m1,w1),(m2,w2),(m3,w3)}。
  //   完备枚举论证: 6 个完全匹配恰这 2 个无阻挡对。
  const t1 = {
    proposers: { m1: ['w2', 'w1', 'w3'], m2: ['w1', 'w2', 'w3'], m3: ['w1', 'w3', 'w2'] },
    receivers: { w1: ['m1', 'm2', 'm3'], w2: ['m2', 'm1', 'm3'], w3: ['m1', 'm2', 'm3'] },
  };
  const da = deferredAcceptance(t1);
  ok(canon(da.matching) === 'm1:w2,m2:w1,m3:w3', `3×3 求婚方最优 = 手工推演 {(m1,w2),(m2,w1),(m3,w3)}（得到 ${canon(da.matching)}）`);
  ok(da.rounds === 2 && da.proposals === 4, `轮数=${da.rounds}=2、求婚=${da.proposals}=4（第1轮 m3 被 w1 拒，第2轮转投 w3）`);
  ok(isStable(da.matching, t1).stable, '3×3 求婚方最优无阻挡对');
  const ex = latticeExtremes(t1);
  ok(canon(ex.receiverOptimal) === 'm1:w1,m2:w2,m3:w3', `3×3 接收方最优 = 手工反向推演 {(m1,w1),(m2,w2),(m3,w3)}（得到 ${canon(ex.receiverOptimal)}）`);
  ok(ex.roundsReceiver === 3, `接收方发起 ${ex.roundsReceiver}=3 轮（w3 连拒 m1、m2 后被 m3 接受）`);
  ok(canon(ex.proposerOptimal) === canon(da.matching) && ex.differ, '两方向 GS = 格两极值，顶 ≠ 底（3×3 例稳定匹配不止一个）');
  const unstable = isStable({ m1: 'w1', m2: 'w3', m3: 'w2' }, t1);
  ok(
    !unstable.stable && JSON.stringify(unstable.blockingPairs) === JSON.stringify([['m1', 'w2'], ['m2', 'w2']]),
    `阻挡对证人: (m1,w2)、(m2,w2) 恰为全部私奔对（得到 ${JSON.stringify(unstable.blockingPairs)}）`,
  );
  const enum1 = allStableMatchings(t1);
  ok(enum1.count === 2, `3×3 枚举恰 ${enum1.count}=2 个稳定匹配（其余 4 个完全匹配均有阻挡对）`);
  ok(
    near(enum1.scanned, 34, 0),
    `枚举扫描 ${enum1.scanned}=34 个候选 = Σ_k C(3,k)·P(3,k)（部分单射匹配全空间，含单身分支）`,
  );
  ok(
    enum1.matchings.every((m) => isStable(m, t1).stable) &&
      enum1.matchings.some((m) => canon(m) === canon(da.matching)) &&
      enum1.matchings.some((m) => canon(m) === canon(ex.receiverOptimal)),
    '枚举集全部稳定且包含两个 GS 极值',
  );

  // 4×4 块对角实例: {m1,m2}↔{w1,w2} 与 {m3,m4}↔{w3,w4} 两块各 2 个稳定
  // 匹配、块间无人想跨块（各自 top-2 全在本块）→ 恰 2×2=4 个稳定匹配，
  // 呈格钻石（中间两个不可比）。
  const t2 = {
    proposers: {
      m1: ['w2', 'w1', 'w3', 'w4'],
      m2: ['w1', 'w2', 'w4', 'w3'],
      m3: ['w4', 'w3', 'w1', 'w2'],
      m4: ['w3', 'w4', 'w2', 'w1'],
    },
    receivers: {
      w1: ['m1', 'm2', 'm3', 'm4'],
      w2: ['m2', 'm1', 'm4', 'm3'],
      w3: ['m3', 'm4', 'm1', 'm2'],
      w4: ['m4', 'm3', 'm2', 'm1'],
    },
  };
  const ex2 = latticeExtremes(t2);
  ok(canon(ex2.proposerOptimal) === 'm1:w2,m2:w1,m3:w4,m4:w3', `4×4 格顶 = 两块各自求婚方最优（${canon(ex2.proposerOptimal)}）`);
  ok(canon(ex2.receiverOptimal) === 'm1:w1,m2:w2,m3:w3,m4:w4', `4×4 格底 = 两块各自接收方最优（${canon(ex2.receiverOptimal)}）`);
  ok(ex2.roundsProposer === 1 && ex2.roundsReceiver === 1, `双方首轮全部互相首选即定: 各 1 轮（顶 ${ex2.roundsProposer} / 底 ${ex2.roundsReceiver}）`);
  const enum2 = allStableMatchings(t2);
  ok(
    enum2.count === 4 && near(enum2.scanned, 209, 0),
    `4×4 恰 ${enum2.count}=4 个稳定匹配（扫描 ${enum2.scanned}=209 = Σ_k C(4,k)·P(4,k) 候选; 组合独立性 2×2）`,
  );
  const mid = enum2.matchings.filter((m) => canon(m) !== canon(ex2.proposerOptimal) && canon(m) !== canon(ex2.receiverOptimal));
  const rank2 = (m, p) => t2.proposers[p].indexOf(m[p]); // 小 = 好
  const [x, y] = mid;
  const xBetter = ['m1', 'm2', 'm3', 'm4'].some((p) => rank2(x, p) < rank2(y, p));
  const yBetter = ['m1', 'm2', 'm3', 'm4'].some((p) => rank2(x, p) > rank2(y, p));
  ok(
    mid.length === 2 && xBetter && yBetter,
    `格钻石: 中间层恰 2 个且不可比（x 有更优分量 ∧ y 也有——稳定匹配集是格不是链）`,
  );

  // 唯一稳定匹配退化例: 顶 = 底
  const uniq = {
    proposers: { P1: ['R1', 'R2'], P2: ['R2', 'R1'] },
    receivers: { R1: ['P1', 'P2'], R2: ['P2', 'P1'] },
  };
  const exu = latticeExtremes(uniq);
  ok(
    allStableMatchings(uniq).count === 1 && !exu.differ && canon(exu.proposerOptimal) === 'P1:R1,P2:R2',
    '唯一稳定匹配实例: 枚举恰 1 个、顶=底（{(P1,R1),(P2,R2)}）',
  );
}

// ═══════════════════ ② 随机实例稳定性 ═══════════════════

section('61.0-② 随机实例稳定性（种子化 n=6~8 × 60）');

{
  let allStable = true;
  let perfect = true;
  let bounded = true;
  let inverseOK = true;
  for (let i = 0; i < 60; i += 1) {
    const n = 6 + (i % 3);
    const problem = randomMatchingProblem(n, 1000 + i);
    const da = deferredAcceptance(problem);
    const ex = latticeExtremes(problem);
    if (!isStable(da.matching, problem).stable) allStable = false;
    if (!isStable(ex.receiverOptimal, problem).stable) allStable = false;
    if (Object.keys(da.matching).length !== n) perfect = false;
    if (da.proposals > n * n) bounded = false;
    for (const [p, r] of Object.entries(da.matching)) {
      if (da.inverse[r] !== p) inverseOK = false;
    }
  }
  ok(allStable, '60 个随机实例 × 双向 GS 输出全部无阻挡对（isStable 全过）');
  ok(perfect, '完备偏好 → 完美匹配（n 方全部成对）');
  ok(bounded, '求婚次数 ≤ n²（经典上界，60 实例全过）');
  ok(inverseOK, 'matching 与 inverse 互逆一致');
}

// ═══════════════════ ③ 格序逐对验证 ═══════════════════

section('61.0-③ 格序: 求婚方最优 ≽ 接收方最优（逐分量，双向同时成立）');

{
  let orderOK = true;
  let dualOK = true;
  let strictTotal = 0;
  let differCount = 0;
  for (let i = 0; i < 60; i += 1) {
    const n = 6 + (i % 3);
    const problem = randomMatchingProblem(n, 2000 + i);
    const { proposerOptimal: topM, receiverOptimal: botM, differ } = latticeExtremes(problem);
    if (differ) differCount += 1;
    for (const [p, list] of Object.entries(problem.proposers)) {
      if (list.indexOf(topM[p]) > list.indexOf(botM[p])) orderOK = false; // 顶名次 ≤ 底名次
      if (list.indexOf(topM[p]) < list.indexOf(botM[p])) strictTotal += 1;
    }
    const invTop = invert(topM);
    const invBot = invert(botM);
    for (const [r, list] of Object.entries(problem.receivers)) {
      if (list.indexOf(invBot[r]) > list.indexOf(invTop[r])) dualOK = false; // 接收方反向
    }
  }
  ok(orderOK, '求婚方逐对: 每方在求婚方最优中的名次 ≤ 接收方最优中的名次（60 实例 ×6~8 方）');
  ok(dualOK, '接收方反向同时成立（顶=求婚方最优 ∧ 底=接收方最优，Conway 格定理）');
  ok(strictTotal > 0, `格非平凡: 严格更优分量共 ${strictTotal} 处`);
  ok(differCount > 0, `${differCount}/60 个实例顶 ≠ 底`);
}

// ═══════════════════ ④ 全体稳定匹配枚举 ═══════════════════

section('61.0-④ 全体稳定匹配枚举（n=5 × 6 实例）');

{
  let allStable = true;
  let extremesIn = true;
  let distinct = true;
  let countSum = 0;
  for (let i = 0; i < 6; i += 1) {
    const problem = randomMatchingProblem(5, 3000 + i);
    const { matchings } = allStableMatchings(problem);
    const { proposerOptimal, receiverOptimal } = latticeExtremes(problem);
    const set = new Set(matchings.map(canon));
    countSum += matchings.length;
    if (set.size !== matchings.length) distinct = false;
    for (const m of matchings) {
      if (!isStable(m, problem).stable) allStable = false;
    }
    if (!set.has(canon(proposerOptimal)) || !set.has(canon(receiverOptimal))) extremesIn = false;
  }
  ok(allStable, '枚举出的匹配全部无阻挡对（枚举器零假阳性）');
  ok(distinct, '枚举无重复（两两不同）');
  ok(extremesIn, '两个 GS 极值都在枚举集内（GS 顶/底 = 全体稳定匹配的 join/meet）');
  ok(countSum >= 6, `6 实例共 ${countSum} 个稳定匹配（每实例 ≥ 1，存在性定理落地）`);
}

// ═══════════════════ ⑤ DSIC 谎报抽样 ═══════════════════

section('61.0-⑤ DSIC: 求婚方谎报偏好从不改善（550 次完整排列谎报）');

{
  const sizes = [6, 7, 8, 8, 7];
  const lieRnd = mulberry32(777);
  let lies = 0;
  let violations = 0;
  let ties = 0;
  let worse = 0;
  let firstViolation = '';
  sizes.forEach((n, s) => {
    const problem = randomMatchingProblem(n, 4000 + s);
    const truth = deferredAcceptance(problem);
    const names = Object.keys(problem.proposers);
    for (let t = 0; t < 110; t += 1) {
      const liar = names[(t * 7 + s * 3) % names.length];
      const trueList = problem.proposers[liar];
      const honest = truth.matching[liar];
      const lied = {
        proposers: { ...problem.proposers, [liar]: shuffle(trueList, lieRnd) },
        receivers: problem.receivers,
      };
      const partner = deferredAcceptance(lied).matching[liar];
      const rankHonest = trueList.indexOf(honest);
      const rankLie = trueList.indexOf(partner);
      lies += 1;
      if (rankLie < rankHonest) {
        violations += 1;
        if (!firstViolation) firstViolation = `seed=${4000 + s} ${liar}: 诚实第 ${rankHonest} → 谎报第 ${rankLie}`;
      } else if (rankLie === rankHonest) ties += 1;
      else worse += 1;
    }
  });
  ok(
    violations === 0,
    `550 次随机完整排列谎报: 真实名次无一改善（违例 ${violations}${firstViolation ? `，首例 ${firstViolation}` : ''}）—— Gale–Sotomayor DSIC`,
  );
  ok(lies === 550 && ties + worse === 550, `抽样计数闭合: ${lies} 次 = 平局 ${ties} + 变差 ${worse}（谎报至多一样好）`);
}

// ═══════════════════ ⑥ TTC 房屋交换核 ═══════════════════

section('61.0-⑥ TTC: 文献结构例对照 + 核成员 + 核单点性（Roth–Postlewaite）');

{
  // Shapley–Scarf 1974 最小市场: 互指 → 一轮互换
  const two = {
    owners: { u: 'hu', v: 'hv' },
    housePrefs: { u: ['hv', 'hu'], v: ['hu', 'hv'] },
  };
  const r2 = topTradingCycles(two);
  ok(
    canon(r2.allocation) === 'u:hv,v:hu' && r2.rounds === 1 && r2.cycles.length === 1,
    `2 人互指: 一轮互换（${canon(r2.allocation)}）`,
  );
  ok(inCore(r2.allocation, two).inCore, '2 人互换在核中');

  // 自留圈 + 互换圈同轮并行清空
  const mixed = {
    owners: { p1: 'h1', p2: 'h2', p3: 'h3' },
    housePrefs: { p1: ['h1', 'h2', 'h3'], p2: ['h3', 'h2', 'h1'], p3: ['h2', 'h3', 'h1'] },
  };
  const rm = topTradingCycles(mixed);
  ok(
    canon(rm.allocation) === 'p1:h1,p2:h3,p3:h2' && rm.rounds === 1 && rm.cycles.length === 2,
    `自留圈 [p1] 与互换圈 [p2,p3] 同轮清空（${canon(rm.allocation)}）`,
  );
  ok(inCore(rm.allocation, mixed).inCore, '自留+互换分配在核中');

  // 三方大圈: 一轮人人首选
  const ring = {
    owners: { q1: 'h1', q2: 'h2', q3: 'h3' },
    housePrefs: { q1: ['h2', 'h3', 'h1'], q2: ['h3', 'h1', 'h2'], q3: ['h1', 'h2', 'h3'] },
  };
  const rr = topTradingCycles(ring);
  ok(
    canon(rr.allocation) === 'q1:h2,q2:h3,q3:h1' && rr.rounds === 1,
    `三方大圈一轮清空: 人人拿到首选（${canon(rr.allocation)}）`,
  );

  // 双圈 + 尾巴（教科书经典结构）: 第1轮 [a,b] 圈（c、d 指向圈内成死路），
  // 第2轮 [c,d] 圈
  const classic = {
    owners: { a: 'h1', b: 'h2', c: 'h3', d: 'h4' },
    housePrefs: { a: ['h2', 'h1', 'h3', 'h4'], b: ['h1', 'h2', 'h3', 'h4'], c: ['h1', 'h4', 'h3', 'h2'], d: ['h3', 'h4', 'h2', 'h1'] },
  };
  const rc = topTradingCycles(classic);
  ok(
    canon(rc.allocation) === 'a:h2,b:h1,c:h4,d:h3' && rc.rounds === 2,
    `双圈+尾巴: 第1轮清 [a,b]、第2轮清 [c,d]（${canon(rc.allocation)}，${rc.rounds} 轮）`,
  );
  ok(inCore(rc.allocation, classic).inCore, '双圈+尾巴结果在核中');

  // inCore 证人: 恒等分配（人人自留初始房产）应被抓出 {a,b} 联盟违例
  const idCheck = inCore({ a: 'h1', b: 'h2', c: 'h3', d: 'h4' }, classic);
  ok(
    !idCheck.inCore &&
      idCheck.violation.coalition.join(',') === 'a,b' &&
      canon(idCheck.violation.reallocation) === 'a:h2,b:h1',
    `核检查器证人: 恒等分配被联盟 {a,b} 阻挡（重分配 a:h2,b:h1 人人严格更优）`,
  );

  // 强核单点性: 枚举一切 n! 分配，强核中恰 1 个且 = TTC 输出
  // （弱核可含多个分配——弱/强口径见内核 CoreCheckOptions；TTC 两个口径都在核中）
  let singleton = true;
  let weakAlso = true;
  let markets = 0;
  let allocations = 0;
  for (const [n, seed] of [
    [4, 1],
    [4, 2],
    [5, 3],
    [5, 4],
    [5, 5],
  ]) {
    const market = randomHousingMarket(n, seed);
    const agents = Object.keys(market.owners);
    const houses = Object.values(market.owners);
    const coreAllocs = [];
    forEachPermutation(houses, (perm) => {
      const alloc = {};
      agents.forEach((a, i) => {
        alloc[a] = perm[i];
      });
      allocations += 1;
      if (inCore(alloc, market, { strong: true }).inCore) coreAllocs.push(canon(alloc));
    });
    const ttcAlloc = topTradingCycles(market).allocation;
    markets += 1;
    if (!(coreAllocs.length === 1 && coreAllocs[0] === canon(ttcAlloc))) singleton = false;
    if (!inCore(ttcAlloc, market).inCore) weakAlso = false;
  }
  ok(
    singleton,
    `强核单点性: ${markets} 个市场（n=4/5）枚举全部 ${allocations} 个分配——强核中恰 1 个且 = TTC 输出（Roth–Postlewaite）`,
  );
  ok(weakAlso, 'TTC 输出同时在弱核中（n=4/5 × 5 市场）');

  // 随机市场核成员: 弱核 n=6 × 40 + 强核 n=5 × 20
  let core40 = true;
  for (let i = 0; i < 40; i += 1) {
    const market = randomHousingMarket(6, 6000 + i);
    if (!inCore(topTradingCycles(market).allocation, market).inCore) core40 = false;
  }
  ok(core40, '随机房屋市场 n=6 × 40: TTC 分配全部在弱核中（无联盟可人人严格改进）');
  let strong20 = true;
  for (let i = 0; i < 20; i += 1) {
    const market = randomHousingMarket(5, 7000 + i);
    if (!inCore(topTradingCycles(market).allocation, market, { strong: true }).inCore) strong20 = false;
  }
  ok(strong20, '随机房屋市场 n=5 × 20: TTC 分配全部在强核中（无联盟可弱改善而改进）');
}

// ═══════════════════ ⑦ 入参校验 ═══════════════════

section('61.0-⑦ 入参校验（显式 throw）与截断偏好语义');

{
  const throws = (fn, label) => {
    try {
      fn();
      ok(false, `${label}: 应 throw`);
    } catch (e) {
      ok(e instanceof Error && e.message.length > 0, `${label} → throw: ${e.message}`);
    }
  };
  throws(
    () => deferredAcceptance({ proposers: { m: ['w', 'w'] }, receivers: { w: ['m'] } }),
    '偏好不严格（w 重复）',
  );
  throws(
    () => deferredAcceptance({ proposers: { m: ['x'] }, receivers: { w: ['m'] } }),
    '偏好含未知接收方 x',
  );
  throws(
    () => deferredAcceptance({ proposers: { '1': ['w'] }, receivers: { w: ['1'] } }),
    '整数样式名（Record 键序陷阱）',
  );
  throws(
    () => isStable({ m1: 'w1', m2: 'w1' }, { proposers: { m1: ['w1'], m2: ['w1'] }, receivers: { w1: ['m1', 'm2'] } }),
    'isStable 非单射匹配',
  );
  throws(() => allStableMatchings(randomMatchingProblem(8, 99)), '枚举空间 9⁸ > 1e6 拒绝');
  throws(
    () => topTradingCycles({ owners: { a: 'h1', b: 'h2' }, housePrefs: { a: ['h2'], b: ['h1', 'h2'] } }),
    '房屋偏好不完整（a 缺 h1）',
  );
  throws(
    () => topTradingCycles({ owners: { a: 'h1', b: 'h1' }, housePrefs: { a: ['h1'], b: ['h1'] } }),
    '产权重复（h1 双 owner）',
  );
  throws(() => inCore({}, randomHousingMarket(11, 1)), 'inCore n>10 保护');

  // 截断偏好 = 不可接受: 不硬配，宁缺毋滥且仍稳定
  const partial = {
    proposers: { m1: ['w1'], m2: ['w1'] },
    receivers: { w1: ['m2', 'm1'], w2: ['m1', 'm2'] },
  };
  const rp = deferredAcceptance(partial);
  ok(
    canon(rp.matching) === 'm2:w1' && isStable(rp.matching, partial).stable,
    `截断偏好: w1 归 m2、m1 与 w2 互不接受各自单身仍稳定（${canon(rp.matching)}）`,
  );

  // 空市场优雅返回
  const empty = deferredAcceptance({ proposers: {}, receivers: {} });
  ok(Object.keys(empty.matching).length === 0 && empty.rounds === 0, '空市场: 空匹配、0 轮（不 throw）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
