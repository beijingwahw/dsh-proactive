/**
 * verify-compression-distance.mjs — 68.0 压缩距离内核纯数学离线验证
 *
 * 锚点（对照内核文件头的诚实边界三条）:
 *   ① 压缩器健全性: 'ab'×2000 压缩比 <5% 且随长度单调下降；种子化
 *      伪随机串压不动（12 bit 固定码下反而膨胀 1.37×）
 *   ② 自距离定律: 固定 12 位码的 LZ78 族压缩器自距离不趋于 0，而趋于
 *      √2−1 ≈ 0.4142（短语 1,2,3,… 等差增长律：|x| 字节 ≈ √(2|x|) 码，
 *      x·x ≈ √2 倍码数）——'ab'×2000 实测 0.4127，闭式对照差 0.0015。
 *      「NCD(x,x)≈0」的诚实形式 = 自距离是全行严格最小且 < 0.6。
 *      （理想值 <0.1 需熵编码级压缩器，12 位码口径下不可达——不掩盖）
 *   ③ 家族分离: A/B 两族各 4 条中英混合串，族内平均 0.613 < 族间 0.814
 *   ④ 次可加性: 289 有序对抽样 C(x+y) ≤ C(x)+C(y)+24bit，实测 slack=0
 *   ⑤ 非度量诚实报告: 穷举 {a,b}≤6 全部 127 串——三角不等式违反 15 处
 *      （率 1.5e-5），见证 d(abab,aaabaa)=1.0 > d(abab,baab)+d(baab,aaabaa)
 *      =0.5+0.375；同一家族语料 0 违反（违反是可能的，非必然——公理
 *      无保证，如实统计）
 *   ⑥ 层次聚类（average-linkage）: k=2 与 threshold=0.7 均 100% 恢复
 *      真分组；threshold=0 退化为单点簇；合并距离序列非降
 *
 * 全部断言确定性（伪随机串用内核自带 mulberry32 的 pseudoRandomString，
 * 同 seed 同输出）。运行：node --experimental-strip-types scripts/verify-compression-distance.mjs
 */

import {
  lzwCompress,
  compressedBits,
  ncd,
  ncdMatrix,
  ncdCluster,
  ncdTriangleAudit,
  pseudoRandomString,
  LZW_SELF_DISTANCE_ASYMPTOTE,
} from '../src/core/compression-distance.ts';

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

// ─────────────────────────── 语料（全部确定性） ───────────────────────────

// A 族: 模型调度主题（共享句骨架，仅槽位词变化）
const familyA = [
  '调度器在多个模型之间分配任务时，优先选择预期收益最高的模型；当预算紧张时，调度器降低探索率并复用历史经验，避免重复交学费。',
  '调度器在多个模型之间分配请求时，优先选择延迟最低的模型；当负载紧张时，调度器降低并发数并复用历史经验，避免重复交学费。',
  '调度器在多个模型之间分配流量时，优先选择质量最好的模型；当配额紧张时，调度器降低重试率并复用历史经验，避免重复交学费。',
  '调度器在多个模型之间分配作业时，优先选择成本最低的模型；当令牌紧张时，调度器降低采样率并复用历史经验，避免重复交学费。',
];
// B 族: 网络传输主题（另一套骨架与词汇）
const familyB = [
  '网络代理在跨区域传输数据包时，优先复用已建立的长连接；当超时计数增多时，代理收敛重传窗口并切换备用链路，防止雪崩放大。',
  '网络代理在跨区域传输报文分段时，优先复用已建立的隧道；当丢包计数增多时，代理收敛发送窗口并切换备用链路，防止雪崩放大。',
  '网络代理在跨区域传输媒体流时，优先复用已建立的通道；当抖动计数增多时，代理收敛缓冲水位并切换备用链路，防止雪崩放大。',
  '网络代理在跨区域传输文件块时，优先复用已建立的会话；当重置计数增多时，代理收敛队列深度并切换备用链路，防止雪崩放大。',
];
const familyItems = [...familyA, ...familyB];
const truth = [0, 0, 0, 0, 1, 1, 1, 1];
const random2048 = pseudoRandomString(2048, 42);
const ab500 = 'ab'.repeat(500);
const ab2000 = 'ab'.repeat(2000);
const sentence = '调度器优先选择预期收益最高的模型并复用历史经验。';

// ═══════════════════ ① 压缩器健全性 ═══════════════════

section('① LZW 压缩器: 高重复串压得动、高熵串压不动');

{
  const ratio = (s) => {
    const r = lzwCompress(s);
    return r.bits / 8 / r.bytes;
  };
  const r500 = ratio('ab'.repeat(500));
  const r1000 = ratio('ab'.repeat(1000));
  const r2000 = ratio(ab2000);
  ok(
    r500 > r1000 && r1000 > r2000 && r2000 < 0.05,
    `'ab'×500/1000/2000 压缩比单调下降 ${(r500 * 100).toFixed(2)}% > ${(r1000 * 100).toFixed(2)}% > ${(r2000 * 100).toFixed(2)}% < 5%（锚点①）`,
  );
  const rr = lzwCompress(random2048);
  const rRnd = rr.bits / 8 / rr.bytes;
  ok(rRnd >= 1.2, `伪随机串(2048,seed42)压缩比 ${(rRnd * 100).toFixed(1)}% ≥ 120%（熵率下限：12 bit 固定码压不动高熵，反而膨胀）`);
  ok(rRnd > 20 * r2000, `高熵 vs 高重复压缩比 ${(rRnd / r2000).toFixed(1)}× > 20×（压缩器区分得了结构有无）`);
  ok(rr.codes.length === 1865, `random2048 码数 ${rr.codes.length}（种子化确定性锚点：期望 1865）`);
  ok(rr.codes.every((c) => c >= 0 && c < 4096) && rr.dictEntries >= 256 && rr.dictEntries <= 4096, `全部码 < 4096 且字典 ${rr.dictEntries} ∈ [256, 4096]（12 位地址空间纪律）`);

  const fixed = [ab2000, random2048, familyA[0], sentence.repeat(100), ''];
  ok(
    fixed.every((s) => lzwCompress(s).bits === lzwCompress(s).codes.length * 12),
    'bits = codes.length × 12 恒成立（固定宽口径，文档化）',
  );
  ok(compressedBits('') === 0 && compressedBits('a') === 12, `空串 0 bit、单字符 ${compressedBits('a')} bit（边界）`);
  const cn = lzwCompress(sentence);
  ok(cn.bytes === Buffer.byteLength(sentence, 'utf8'), `UTF-8 字节数 ${cn.bytes} = ${sentence.length} 汉字 × 3（自实现编码器与宿主一致）`);
  ok(
    JSON.stringify(lzwCompress(familyA[0]).codes) === JSON.stringify(lzwCompress(familyA[0]).codes) &&
      pseudoRandomString(64, 7) === pseudoRandomString(64, 7),
    '同输入同输出：压缩码流与伪随机串逐位确定（内核零随机性依赖）',
  );
}

// ═══════════════════ ② 自距离定律 ═══════════════════

section('② NCD 自距离: √2−1 定律与行最小性（诚实口径）');

{
  ok(ncd('', '') === 0, `ncd('','') = 0（两空串定义距离 0）`);
  const selfAb = ncd(ab2000, ab2000);
  ok(
    near(selfAb, LZW_SELF_DISTANCE_ASYMPTOTE, 0.005),
    `NCD('ab'×2000,'ab'×2000) = ${selfAb.toFixed(4)} ≈ √2−1 = ${LZW_SELF_DISTANCE_ASYMPTOTE.toFixed(4)}（LZ78 短语等差增长律的闭式渐近线，偏差 ${Math.abs(selfAb - LZW_SELF_DISTANCE_ASYMPTOTE).toFixed(4)}）`,
  );
  const selfs = [...familyItems, random2048, ab2000].map((s) => ncd(s, s));
  const maxSelf = Math.max(...selfs);
  ok(maxSelf < 0.6, `全部语料 NCD(x,x) ∈ [${Math.min(...selfs).toFixed(3)}, ${maxSelf.toFixed(3)}] < 0.6（自距离受 √2−1 定律托底——12 位固定码口径下 ≠0，锚点②的诚实形式）`);

  const m = ncdMatrix(familyItems);
  let rowMinimal = true;
  let worstMargin = Infinity;
  for (let i = 0; i < 8; i += 1) {
    for (let j = 0; j < 8; j += 1) {
      if (i === j) continue;
      if (!(m[i][i] < m[i][j])) rowMinimal = false;
      worstMargin = Math.min(worstMargin, m[i][j] - m[i][i]);
    }
  }
  ok(rowMinimal, `族矩阵对角线是全行严格最小（最差裕量 ${worstMargin.toFixed(4)}）——「和自己最近」即内容同一性的可操作判据`);
  const nearDup = ncd(ab2000, 'ab'.repeat(2100));
  const crossScale = ncd(ab2000, 'ab'.repeat(4000));
  ok(nearDup < 0.45, `近重复 NCD('ab'×2000,'ab'×2100) = ${nearDup.toFixed(4)} < 0.45（查重用例：长度差 5% 内容同源仍近邻）`);
  ok(crossScale < 0.6, `跨尺度 NCD('ab'×2000,'ab'×4000) = ${crossScale.toFixed(4)} < 0.6（同族不同长度仍近，远低于族间 0.81）`);
}

// ═══════════════════ ③ 家族分离 ═══════════════════

section('③ NCD 家族分离: 族内近、族间远（零嵌入模型）');

{
  const m = ncdMatrix(familyItems);
  let symmetric = true;
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) if (m[i][j] !== m[j][i]) symmetric = false;
  ok(symmetric, '矩阵严格对称（双方向拼接均值口径的内生保证，m[i][j] === m[j][i] 逐位相等）');
  ok(near(m[0][0], ncd(familyItems[0], familyItems[0])), '矩阵对角 = ncd(x,x) 直算（口径一致性）');

  let intraSum = 0;
  let intraN = 0;
  let interSum = 0;
  let interN = 0;
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) {
      if (truth[i] === truth[j]) {
        intraSum += m[i][j];
        intraN += 1;
      } else {
        interSum += m[i][j];
        interN += 1;
      }
    }
  }
  const intra = intraSum / intraN;
  const inter = interSum / interN;
  ok(inter - intra > 0.15, `族内平均 ${intra.toFixed(4)} < 族间平均 ${inter.toFixed(4)}（差 ${(inter - intra).toFixed(4)} > 0.15，锚点③——语义相近的语法无关代理成立）`);
  ok(ncd(random2048, ab2000) >= 0.99, `NCD(随机串,'ab'×2000) = ${ncd(random2048, ab2000).toFixed(4)} ≥ 0.99（无关串贴顶）`);
  const rndPair = ncd(pseudoRandomString(2048, 1), pseudoRandomString(2048, 2));
  ok(rndPair >= 0.85, `两条独立种子随机串 NCD = ${rndPair.toFixed(4)} ≥ 0.85（高熵互斥，低于 1 是碰撞对的共享结构——如实报告）`);
  const diagMean = m.reduce((a, r, i) => a + r[i], 0) / 8;
  ok(diagMean < intra, `对角均值 ${diagMean.toFixed(4)} < 族内均值 ${intra.toFixed(4)}（自己 < 族内近邻 < 族间，距离序完整）`);
}

// ═══════════════════ ④ 次可加性 ═══════════════════

section('④ 次可加性抽样: C(x+y) ≤ C(x)+C(y)+O(1)');

{
  const pool = [
    ...familyItems,
    random2048,
    pseudoRandomString(512, 7),
    ab500,
    ab2000,
    sentence,
    sentence.repeat(100),
    sentence.repeat(100) + '尾巴上有两个汉字',
    familyA[0].slice(0, 30),
    '',
  ];
  let pairs = 0;
  let maxSlack = -Infinity;
  let maxRatio = 0;
  let slackPositive = 0;
  for (const x of pool) {
    for (const y of pool) {
      const cx = compressedBits(x);
      const cy = compressedBits(y);
      const cxy = compressedBits(x + y);
      const slack = cxy - cx - cy;
      pairs += 1;
      if (slack > maxSlack) maxSlack = slack;
      if (slack > 0) slackPositive += 1;
      const denom = cx + cy;
      if (denom > 0) maxRatio = Math.max(maxRatio, cxy / denom);
    }
  }
  ok(maxSlack <= 24, `全部 ${pairs} 有序对 slack = C(x+y)−C(x)−C(y) ≤ 24 bit（实测最大 ${maxSlack} bit，${slackPositive} 对 > 0——次可加性以 2 码内常数成立，锚点④）`);
  ok(maxRatio <= 1 + 1e-9, `最大超加比 C(x+y)/(C(x)+C(y)) = ${maxRatio.toFixed(9)} ≤ 1（拼接联合压缩从不吃亏）`);
}

// ═══════════════════ ⑤ 非度量的诚实报告 ═══════════════════

section('⑤ 三角不等式违反率: 全量枚举统计，不掩盖');

{
  // 穷举语料: {a,b} 上长度 0..6 的全部 127 串
  const exhaustive = [''];
  for (let len = 1; len <= 6; len += 1) {
    for (let mask = 0; mask < 2 ** len; mask += 1) {
      exhaustive.push(mask.toString(2).padStart(len, '0').replace(/0/g, 'a').replace(/1/g, 'b'));
    }
  }
  const audit = ncdTriangleAudit(exhaustive);
  ok(
    audit.triples === 333375 && audit.violations === 15 && near(audit.violationRate, 1.5e-5, 1e-6) && near(audit.worstSlack, 0.125),
    `穷举 {a,b}≤6 共 127 串: ${audit.triples} 三元组 × 3 不等式，违反 ${audit.violations} 处（率 ${audit.violationRate}，最坏松弛 ${audit.worstSlack}）——NCD 非度量是事实不是传闻（锚点⑤）`,
  );
  const dxz = ncd('abab', 'aaabaa');
  const dxy = ncd('abab', 'baab');
  const dyz = ncd('baab', 'aaabaa');
  ok(
    near(dxz, 1.0) && near(dxy, 0.5) && near(dyz, 0.375) && dxz > dxy + dyz,
    `见证三元组 d('abab','aaabaa')=${dxz} > d('abab','baab')=${dxy} + d('baab','aaabaa')=${dyz}（违反松弛 ${dxz - dxy - dyz}——短串的字典量化尘埃即可构造违反）`,
  );
  const famAudit = ncdTriangleAudit(familyItems);
  ok(
    famAudit.violations === 0,
    `家族 8 条语料: ${famAudit.triples} 三元组 0 违反（最坏松弛 ${famAudit.worstSlack} < 0）——公理无保证 ≠ 必然违反；违反率依语料而变，两侧都如实报告`,
  );
}

// ═══════════════════ ⑥ 层次聚类 ═══════════════════

section('⑥ average-linkage 层次聚类: 100% 恢复真分组');

{
  const cl = ncdCluster(familyItems, { k: 2 });
  ok(
    cl.assignments.every((v, i) => v === truth[i]),
    `k=2 聚类 assignments=[${cl.assignments.join(',')}] 与真分组 [${truth.join(',')}] 逐位一致（锚点⑥：一致率 100%）`,
  );
  ok(cl.k === 2 && cl.intraMeanNcd < cl.interMeanNcd && cl.diameterNcd < cl.interMeanNcd, `k=2: 族内 ${cl.intraMeanNcd} < 直径 ${cl.diameterNcd} < 族间 ${cl.interMeanNcd}（簇结构紧致可分）`);
  ok(
    cl.merges.length === 6 && cl.merges.every((mg, i) => i === 0 || mg.distance >= cl.merges[i - 1].distance - 1e-9),
    `合并审计 ${cl.merges.length} 次（8→2），链距离非降 [${cl.merges.map((mg) => mg.distance.toFixed(3)).join(' ')}]（average-linkage 无倒挂，可逐层追溯）`,
  );

  const clT = ncdCluster(familyItems, { threshold: 0.7 });
  ok(
    clT.mode === 'threshold' && clT.k === 2 && clT.assignments.every((v, i) => v === truth[i]),
    `threshold=0.7: k=${clT.k} 同样 100% 恢复真分组（阈值落在族内 0.613 与族间 0.814 之间）`,
  );
  const clZero = ncdCluster(familyItems, { threshold: 0 });
  ok(
    clZero.k === 8 && clZero.assignments.every((v, i) => v === i) && clZero.merges.length === 0,
    `threshold=0: 不合并，k=8 单点簇、assignments=[0..7]（阈值下限的退化行为正确）`,
  );
  const clAll = ncdCluster(familyItems, { k: 8 });
  ok(clAll.k === 8 && clAll.assignments.every((v, i) => v === i), `k=8: 单点簇逐一返回（k 上界行为正确）`);
  const clOne = ncdCluster(familyItems, { k: 1 });
  ok(
    clOne.k === 1 && clOne.assignments.every((v) => v === 0) && near(clOne.intraMeanNcd, clOne.interMeanNcd),
    `k=1: 全体一簇，intra=${clOne.intraMeanNcd} = inter=${clOne.interMeanNcd}（单簇时 inter 诚实退化为全体对均值）`,
  );
}

// ═══════════════════ 入参校验 ═══════════════════

section('入参校验: 显式 throw（无静默 NaN 路径）');

{
  ok(throws(() => lzwCompress(42)), 'lzwCompress(42) throw（非 string）');
  ok(throws(() => ncd(null, '')), 'ncd(null, "") throw（非 string）');
  ok(throws(() => ncdMatrix([])), 'ncdMatrix([]) throw（空数组）');
  ok(throws(() => ncdMatrix(['a', 5])), 'ncdMatrix(["a", 5]) throw（元素非 string）');
  ok(throws(() => ncdCluster(familyItems, {})), 'ncdCluster(items, {}) throw（k 与 threshold 缺一不可）');
  ok(throws(() => ncdCluster(familyItems, { k: 2, threshold: 0.5 })), 'ncdCluster({k, threshold}) throw（二者只能给一）');
  ok(throws(() => ncdCluster(familyItems, { k: 0 })), 'ncdCluster({k:0}) throw（k < 1）');
  ok(throws(() => ncdCluster(familyItems, { k: 9 })), 'ncdCluster({k:9}) throw（k > n=8）');
  ok(throws(() => ncdCluster(familyItems, { threshold: 3 })), 'ncdCluster({threshold:3}) throw（阈值出界 [0,2]）');
  ok(throws(() => ncdTriangleAudit(['a', 'b'])), 'ncdTriangleAudit(2 条) throw（< 3 条无三元组）');
  ok(throws(() => pseudoRandomString(-1, 1)), 'pseudoRandomString(-1) throw（负长度）');
  ok(throws(() => pseudoRandomString(4.2, 1)), 'pseudoRandomString(4.2) throw（非整数长度）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 68.0 压缩距离内核: LZW/NCD/层次聚类数学验证成立');
} else {
  console.error('❌ 存在失败断言');
}
process.exitCode = failed === 0 ? 0 : 1;
