/**
 * argumentation.ts — 81.0 论证内核 —— Dung 抽象论证框架（AF）的裁决语义
 *
 * 升级前的根本局限（辩论有了流程，「接受」却没有定义）：
 * - 7.0 深思内核给出多心智辩论的**流程**（谁先说、谁反驳、几轮收束），
 *   64.0 相关均衡给出独立心智的**协调分布**（信号灯下各让一步）——
 *   但「议会最终**接受**一个结论」到底意味着什么，系统里没有任何地方
 *   有精确回答：靠投票是统计（多数可以对错误连续投票），靠权重是权威
 *   （谁嗓门大谁赢），都绕开了真正的认知问题——这个结论扛得住所有
 *   已提出的攻击吗？
 * - Dung 1995 抽象论证框架把这件事公理化到极简：论证集 A、攻击关系
 *   R ⊆ A×A（(b,a) ∈ R 即 b 攻击 a），其余全部抽象掉。「接受」从此
 *   不是投票结果，而是攻击图的解概念——接受 a ⟺ 存在完整辩护链：
 *   a 的每个攻击者都被某个已接受论证反击，且反击者自身同样防得住，
 *   递归到底。多模型议会里「A 主张 X / B 主张 ¬X / C 质疑 B 的依据」
 *   直接编码为攻击边，裁决 = 求外延（extension）。
 *
 * 数学（语义阶梯，自下而上逐级收紧）：
 * 1. 无冲突集 S：S 内部互不攻击（自攻击者连这一级都进不去）；
 * 2. 可采纳集（admissible）S：无冲突 + 防得住——S 中每个成员的每个
 *    攻击者都被 S 中某成员反击（∅ 恒可采纳）；
 * 3. 完全集（complete）E：可采纳 + 贪心到底——凡被 E 防得住的论证都
 *    已在 E 中（E 是 E = {a : E 防住 a} 的不动点）；
 * 4. 基底外延（grounded）：特征函数 F(S) = S ∪ {a : S 防住 a} 从 ∅ 起
 *    迭代的最小不动点——唯一、多项式可解，且恰等于所有完全集之交
 *    （Dung 定理；本内核以不动点迭代与暴力交集双法互证）；
 * 5. 偏好外延（preferred）：⊆-极大的可采纳集（争议最大化的多世界裁决）；
 * 6. 稳定外延（stable）：无冲突 + 攻击所有外部论证（最强也最脆——
 *    可能不存在）。
 * 定理组（验证锚点的真值来源）：
 * - 自攻击者永远不被接受（任何语义下都进不了无冲突集）；
 * - grounded 唯一且 = ∩{完全集}；grounded ⊆ 每个完全集 ⊆ 每个偏好集
 *   中的成员……注意字面「每个完全集 ⊆ 每个偏好集」不成立（2-环反例：
 *   完全集 {a} ⊄ 偏好集 {b}），成立的是：每个完全集 ⊆ **某个**偏好集；
 * - stable ⊆ preferred ⊆ complete（每个稳定外延都是偏好外延，每个
 *   偏好外延都是完全集）；
 * - 奇环（3-环、5-环…）无稳定外延；偶环恰两个（2-环 a↔b 的稳定外延
 *   就是 {a}、{b}——「无稳定」是奇环的专利）；有向 3-环连非空可采纳
 *   集都没有（唯一偏好外延是 ∅），「grounded 空 + 3 个偏好外延」对应
 *   的是互攻三角形 a↔b↔c↔a——验证脚本把这四种小框架全部锚定，
 *   规格勘误如实标注。
 *
 * 验证锚点（scripts/verify-argumentation.mjs）：
 *   ① 经典小框架逐一对照：单自攻击（grounded=∅、四语义永不接受）、
 *      2-环（grounded=∅、偏好 {a}/{b}、稳定 {a}/{b}）、有向 3-环
 *      （grounded=∅、唯一偏好外延 ∅、无稳定——奇环定理）、互攻三角形
 *      （grounded=∅、3 偏好外延 + 3 稳定外延）、链 a→b→c
 *      （grounded={a,c}、iterations=3、{a,c} 唯一稳定）；
 *   ② 随机图 50 种子（n≤8，含自攻击实例）：grounded 不动点迭代解 =
 *      暴力枚举完全集之交（逐位一致）；独立集 DFS 引擎枚举的
 *      preferred/stable/complete 与 2^n 全子集暴力扫描逐集合一致；
 *   ③ 复辩护（reinstatement）：a↔b 且 c→b——a 被 b 攻击但 b 被 a/c
 *      双杀，a 复活；isAcceptable 重建辩护链（攻击者↦反击者对照），
 *      b 的攻击者无反击者故不可接受；
 *   ④ 语义包含链（经典 + 随机实例全检）：grounded ⊆ 每个完全集/偏好集/
 *      稳定外延；偏好⊆完全、稳定⊆偏好；每个完全集 ⊆ 某个偏好集
 *      （并演示 2-环字面反例）；
 *   ⑤ skeptical/credulous 查询一致性：grounded 接受 ⟹ 疑信偏好接受；
 *      疑信偏好 ⟹ 疑信稳定（稳定族非空时）；轻信稳定 ⟹ 轻信偏好；
 *      memberships 计数与布尔逻辑互洽；自攻击者四语义均不可接受；
 *   ⑥ 入参校验显式抛错、枚举护栏（>16 论证抛，grounded 不受限）、
 *      同种子逐位复现（mulberry32）。
 *
 * 应用：多模型议会辩论裁决——结论及其冲突编码为攻击图：grounded =
 * 最保守裁判（只接受无争议辩护链）、preferred = 多世界裁决（每个外延
 * 一个自洽立场）、stable = 强硬裁决（不存在时诚实报空而非硬选）。
 * 判断层三件套合龙：7.0 深思给辩论**流程**、64.0 相关均衡给协调
 * **分布**、81.0 给「接受 = 存在完整辩护链」的**裁决语义**。
 *
 * R5 进化（第五轮·世界性升级，数学+性能+性质三轴）:
 *   数学轴——价值型论证框架 VAF（value-based AF，Bench-Capon 2003）:
 *     每条论证推崇一个**价值**（Dung AF 抽象掉的东西被显式带回）;
 *     受众 = 价值上的偏好序; 攻击 (a,b) 对受众**成功** ⟺ 攻击者的价值
 *     不劣于被攻击者的价值（value(b) ≻ value(a) 的攻击被受众免疫）。
 *     每个受众把 VAF 投影成一个 Dung AF（保留成功攻击）→ 复用全部
 *     经典语义。Bench-Capon 裁决口径: 客观接受 = 对**一切**受众轻信
 *     接受（preferred 外延含之）; 主观接受 = 对**某些**受众接受——
 *     「同一份辩论，不同价值观得到不同正典」第一次成为可检查量。
 *   性能轴——独立集 DFS 的位掩码化: conflictFreeMasksDfs 原先用
 *     chosen.includes 做 O(k) 冲突查询（每步 O(度×|chosen|)），改为
 *     预计算每论证的冲突掩码 conflictMask[i]（攻击 ∪ 被攻击），栈上
 *     维护 chosenMask，冲突查询 = 一次 AND——**等价证明**: 冲突谓词
 *     (targets∩chosen)∪(attackers∩chosen) ≠ ∅ ⟺ conflictMask[i] &
 *     chosenMask ≠ 0，DFS 访问序不变 ⟹ 枚举序列逐位相同，下游
 *     preferred/stable/complete 输出不变; 位谓词（conflictFreeByMask/
 *     coveredMask/admissibleByMask）同步去 maskMembers 分配化。耗时
 *     对照见 verify-r5-game（vs 脚本内 includes 版参考实现）。
 *   性质轴——VAF 语义 vs 双独立暴力路线 ≥200 种子化实例: ①诱导 Dung
 *     AF + preferredExtensions（DFS 引擎）②VAF 直定义暴力（成功攻击
 *     版无冲突 + 防御 + ⊆-极大）——两路逐受众一致; 客观 ⊆ 主观、
 *     无成功攻击者的论证必主观接受等定理全检。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** mulberry32：32 位种子 → [0,1) 均匀流（同种子同序列——随机框架可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 框架构造 ───────────────────────────

/**
 * Dung 抽象论证框架 AF = (A, R)。
 * 论证用下标 0..size−1 标识（名字仅用于展示/序列化）；
 * 攻击 (x, y) 读作「x 攻击 y」。自攻击 (a,a) 合法（数学上有意义：
 * 自攻击者永不被接受）。
 */
export interface ArgumentFramework {
  /** 论证名（下标即位置；唯一、非空） */
  readonly arguments: ReadonlyArray<string>;
  /** 攻击对 [攻击者下标, 被攻击者下标]（去重、按 (攻击者, 被攻击者) 升序） */
  readonly attacks: ReadonlyArray<readonly [number, number]>;
  /** attackersOf[i]：攻击 i 的论证下标（升序去重） */
  readonly attackersOf: ReadonlyArray<ReadonlyArray<number>>;
  /** targetsOf[i]：i 攻击的论证下标（升序去重） */
  readonly targetsOf: ReadonlyArray<ReadonlyArray<number>>;
  /** 论证数 |A| */
  readonly size: number;
}

/**
 * 枚举型语义（complete/preferred/stable/bruteForce）的论证数上限：
 * 外延族至多 2^n 个，16 = 65536 是纯数学内核的务实护栏
 * （groundedExtension 多项式可解，不受此限）。
 */
export const MAX_ENUM_ARGUMENTS = 16;

/**
 * 框架构造（含合同校验）：
 * @param args 论证名列表（唯一非空字符串）
 * @param attacks 攻击对 [攻击者下标, 被攻击者下标]（越界/非整数抛错；重复对去重）
 */
export function argumentFramework(
  args: ReadonlyArray<string>,
  attacks: ReadonlyArray<readonly [number, number]>,
): ArgumentFramework {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`argumentFramework: 论证名必须是非空字符串（第 ${i} 个收到 ${String(name)}）`);
    }
    if (seen.has(name)) {
      throw new Error(`argumentFramework: 论证名必须唯一（"${name}" 重复出现）`);
    }
    seen.add(name);
  }
  const n = args.length;
  const attackers: number[][] = Array.from({ length: n }, () => [] as number[]);
  const targets: number[][] = Array.from({ length: n }, () => [] as number[]);
  const dedup = new Set<string>();
  const kept: Array<[number, number]> = [];
  for (let i = 0; i < attacks.length; i += 1) {
    const pair = attacks[i];
    const attacker = pair[0];
    const target = pair[1];
    if (!Number.isInteger(attacker) || attacker < 0 || attacker >= n) {
      throw new Error(`argumentFramework: 攻击者下标必须是 [0, ${n - 1}] 的整数（第 ${i} 对收到 ${String(attacker)}）`);
    }
    if (!Number.isInteger(target) || target < 0 || target >= n) {
      throw new Error(`argumentFramework: 被攻击者下标必须是 [0, ${n - 1}] 的整数（第 ${i} 对收到 ${String(target)}）`);
    }
    const key = `${attacker}\u0000${target}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    kept.push([attacker, target]);
    targets[attacker]!.push(target);
    attackers[target]!.push(attacker);
  }
  for (let i = 0; i < n; i += 1) {
    attackers[i]!.sort((a, b) => a - b);
    targets[i]!.sort((a, b) => a - b);
  }
  kept.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    arguments: [...args],
    attacks: kept,
    attackersOf: attackers,
    targetsOf: targets,
    size: n,
  };
}

/**
 * 随机框架（确定性）：n 个论证 a0..a{n−1}，每个有序对 (i,j) 独立以
 * attackProbability 概率成边（i=j 需显式开 selfAttacks）。行优先扫描
 * mulberry32(seed)——同种子同框架。
 */
export function randomFramework(
  size: number,
  attackProbability: number,
  seed: number,
  opts?: { selfAttacks?: boolean },
): ArgumentFramework {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`randomFramework: 论证数必须是非负整数（收到 ${String(size)}）`);
  }
  if (!(attackProbability >= 0 && attackProbability <= 1)) {
    throw new Error(`randomFramework: 攻击概率必须在 [0,1]（收到 ${String(attackProbability)}）`);
  }
  const rng = mulberry32(seed);
  const names = Array.from({ length: size }, (_, i) => `a${i}`);
  const attacks: Array<[number, number]> = [];
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      if (i === j && opts?.selfAttacks !== true) continue;
      if (rng() < attackProbability) attacks.push([i, j]);
    }
  }
  return argumentFramework(names, attacks);
}

// ─────────────────────────── 校验与集合工具 ───────────────────────────

function requireArgumentIndex(index: number, af: { size: number }, fn: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= af.size) {
    throw new Error(`${fn}: 论证下标必须是 [0, ${af.size - 1}] 的整数（收到 ${String(index)}）`);
  }
}

/** 候选集合法化：下标校验 + 去重 + 升序（辩护/外延的规范形态） */
function normalizeSet(S: ReadonlyArray<number>, af: ArgumentFramework, fn: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let k = 0; k < S.length; k += 1) {
    const i = S[k];
    requireArgumentIndex(i, af, fn);
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out.sort((a, b) => a - b);
}

/** 成员表：table[a]=1 ⟺ a ∈ set */
function memberTable(set: ReadonlyArray<number>, size: number): Uint8Array {
  const table = new Uint8Array(size);
  for (const a of set) table[a] = 1;
  return table;
}

/** 无冲突（数组版，任意规模）：S 内部无任何攻击边（含自攻击） */
function conflictFreeArr(set: ReadonlyArray<number>, af: ArgumentFramework): boolean {
  const table = memberTable(set, af.size);
  for (const a of set) {
    const ts = af.targetsOf[a];
    for (let k = 0; k < ts.length; k += 1) {
      if (table[ts[k]!] === 1) return false;
    }
  }
  return true;
}

/** S 的攻击覆盖表：covered[b]=1 ⟺ b 被 S 中某成员攻击 */
function attackedTable(set: ReadonlyArray<number>, af: ArgumentFramework): Uint8Array {
  const covered = new Uint8Array(af.size);
  for (const s of set) {
    const ts = af.targetsOf[s];
    for (let k = 0; k < ts.length; k += 1) covered[ts[k]!] = 1;
  }
  return covered;
}

/** a 是否被防住：a 的每个攻击者都被（覆盖表指示的）S 成员反击 */
function defendedByTable(covered: Uint8Array, a: number, af: ArgumentFramework): boolean {
  const atk = af.attackersOf[a];
  for (let k = 0; k < atk.length; k += 1) {
    if (covered[atk[k]!] !== 1) return false;
  }
  return true;
}

// ─────────────────────────── 语义谓词（公共，任意规模） ───────────────────────────

/** 无冲突集：S 内部互不攻击（自攻击者永不被任何 S 包含） */
export function isConflictFree(S: ReadonlyArray<number>, af: ArgumentFramework): boolean {
  const set = normalizeSet(S, af, 'isConflictFree');
  return conflictFreeArr(set, af);
}

/** S 是否防住 a（= Dung 的 acceptable(a, S) 布尔版） */
export function defends(S: ReadonlyArray<number>, a: number, af: ArgumentFramework): boolean {
  requireArgumentIndex(a, af, 'defends');
  const set = normalizeSet(S, af, 'defends');
  return defendedByTable(attackedTable(set, af), a, af);
}

/** 可采纳集：无冲突 + 防得住（S 中每个成员的每个攻击者都被 S 反击） */
export function isAdmissible(S: ReadonlyArray<number>, af: ArgumentFramework): boolean {
  const set = normalizeSet(S, af, 'isAdmissible');
  if (!conflictFreeArr(set, af)) return false;
  const covered = attackedTable(set, af);
  for (const a of set) {
    if (!defendedByTable(covered, a, af)) return false;
  }
  return true;
}

/** 完全集：可采纳 + 含所有其防得住的论证（E = {a : E 防住 a} 的不动点） */
export function isComplete(S: ReadonlyArray<number>, af: ArgumentFramework): boolean {
  const set = normalizeSet(S, af, 'isComplete');
  if (!isAdmissible(set, af)) return false;
  const covered = attackedTable(set, af);
  const table = memberTable(set, af.size);
  for (let a = 0; a < af.size; a += 1) {
    if (table[a] === 1) continue;
    if (defendedByTable(covered, a, af)) return false; // 防得住却不在集内 → 非完全
  }
  return true;
}

/** 稳定集：无冲突 + 攻击所有外部论证（最强语义；可能不存在） */
export function isStable(S: ReadonlyArray<number>, af: ArgumentFramework): boolean {
  const set = normalizeSet(S, af, 'isStable');
  if (!conflictFreeArr(set, af)) return false;
  const covered = attackedTable(set, af);
  const table = memberTable(set, af.size);
  for (let a = 0; a < af.size; a += 1) {
    if (table[a] === 1) continue;
    if (covered[a] !== 1) return false; // 外部论证未被攻击 → 非稳定
  }
  return true;
}

// ─────────────────────────── 辩护链重建 ───────────────────────────

/** 一条辩护链接：攻击者 ↦ 反击它的 S 成员（defeated = 反击者非空） */
export interface DefenseLink {
  /** 攻击 a 的论证下标 */
  readonly attacker: number;
  /** S 中反击该攻击者的成员下标（升序；空 = 该攻击无人能挡） */
  readonly defenders: ReadonlyArray<number>;
  /** 该攻击是否被挡住（defenders 非空） */
  readonly defeated: boolean;
}

/** 辩护链：a 相对 S 的可接受性全景（复辩护 reinstatement 的审计凭证） */
export interface DefenseChain {
  readonly argument: number;
  /** acceptable(a, S)：a 的每个攻击者都被 S 中某成员反击（无攻击者时空洞成立） */
  readonly acceptable: boolean;
  /** 逐攻击者的反击对照（按攻击者升序） */
  readonly links: ReadonlyArray<DefenseLink>;
}

/**
 * isAcceptable(a, S, af) —— 辩护链重建（Dung 的 acceptable(a, S)）：
 * 「接受一个结论 = 存在完整辩护链」的一级展开——对 a 的每个攻击者
 * 列出 S 中的反击者。a 被攻击但每个攻击都被挡住 ⟹ a 复活
 * （reinstatement：被击败不等于被否决，取决于辩护链是否闭合）。
 */
export function isAcceptable(a: number, S: ReadonlyArray<number>, af: ArgumentFramework): DefenseChain {
  requireArgumentIndex(a, af, 'isAcceptable');
  const set = normalizeSet(S, af, 'isAcceptable');
  const table = memberTable(set, af.size);
  const links: DefenseLink[] = [];
  let acceptable = true;
  const atk = af.attackersOf[a];
  for (let k = 0; k < atk.length; k += 1) {
    const b = atk[k]!;
    // 反击者 = S 中攻击 b 的成员（attackersOf[b] 与 S 之交，升序）
    const defenders: number[] = [];
    const bats = af.attackersOf[b];
    for (let j = 0; j < bats.length; j += 1) {
      const d = bats[j]!;
      if (table[d] === 1) defenders.push(d);
    }
    const defeated = defenders.length > 0;
    if (!defeated) acceptable = false;
    links.push({ attacker: b, defenders, defeated });
  }
  return { argument: a, acceptable, links };
}

// ─────────────────────────── 基底外延（grounded） ───────────────────────────

/** 基底外延结果（不动点迭代的完整审计轨迹） */
export interface GroundedResult {
  /** 基底外延（升序）：F 的最小不动点 = 所有完全集之交 */
  readonly extension: ReadonlyArray<number>;
  /** F 的应用次数（含确认不动点、不新增成员的最后一次；空框架 = 1，链 a→b→c = 3） */
  readonly iterations: number;
  /** 每轮新增成员（trace[r] = 第 r+1 轮 F 应用新防住的论证；升序） */
  readonly trace: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * 基底外延：特征函数 F(S) = S ∪ {a : S 防住 a} 从 ∅ 起迭代至最小不动点。
 *
 * 唯一性/多项式性/「= 所有完全集之交」都是 Dung 定理；本方法只做不动点
 * 迭代（O(rounds·(n+m))，rounds ≤ n+1），与暴力枚举的完全集之交在
 * 验证脚本中逐位互证。最保守裁判：只接受辩护链无争议闭合的论证。
 */
export function groundedExtension(af: ArgumentFramework): GroundedResult {
  const n = af.size;
  const inSet = new Uint8Array(n);
  const trace: number[][] = [];
  let iterations = 0;
  for (;;) {
    iterations += 1;
    // 当前 S 的攻击覆盖表
    const covered = new Uint8Array(n);
    for (let s = 0; s < n; s += 1) {
      if (inSet[s] !== 1) continue;
      const ts = af.targetsOf[s];
      for (let k = 0; k < ts.length; k += 1) covered[ts[k]!] = 1;
    }
    // F 应用：所有被 S 防住的新论证
    const added: number[] = [];
    for (let a = 0; a < n; a += 1) {
      if (inSet[a] === 1) continue;
      if (defendedByTable(covered, a, af)) added.push(a);
    }
    if (added.length === 0) break; // 不动点
    for (const a of added) inSet[a] = 1;
    trace.push(added);
  }
  const extension: number[] = [];
  for (let a = 0; a < n; a += 1) {
    if (inSet[a] === 1) extension.push(a);
  }
  return { extension, iterations, trace };
}

// ─────────────────────────── 枚举内核（位掩码，n ≤ 16） ───────────────────────────

function requireEnumerable(af: ArgumentFramework, fn: string): void {
  if (af.size > MAX_ENUM_ARGUMENTS) {
    throw new Error(
      `${fn}: 枚举型语义仅支持 ≤ ${MAX_ENUM_ARGUMENTS} 个论证（收到 ${af.size}；外延族至多 2^n——groundedExtension 多项式可解不受此限，大规模框架先抽象合并再裁决）`,
    );
  }
}

/** 位掩码 → 升序成员表（掩码 < 2^16 由护栏保证） */
function maskMembers(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_ENUM_ARGUMENTS; i += 1) {
    if (((mask >>> i) & 1) === 1) out.push(i);
  }
  return out;
}

function setToMask(set: ReadonlyArray<number>): number {
  let mask = 0;
  for (const a of set) mask |= 1 << a;
  return mask;
}

/** R5 性能轴: 逐置位迭代（免 maskMembers 分配; 位序 = 升序下标序） */
function forEachMember(mask: number, fn: (i: number) => void): void {
  let m = mask >>> 0;
  while (m !== 0) {
    const low = m & -m;
    fn(31 - Math.clz32(low));
    m ^= low;
  }
}

function conflictFreeByMask(mask: number, af: ArgumentFramework): boolean {
  let ok = true;
  forEachMember(mask, (a) => {
    if (!ok) return;
    const ts = af.targetsOf[a];
    for (let k = 0; k < ts.length; k += 1) {
      if (((mask >>> ts[k]!) & 1) === 1) {
        ok = false;
        return;
      }
    }
  });
  return ok;
}

/** S 的攻击覆盖掩码：被 S 中某成员攻击的论证置位 */
function coveredMask(mask: number, af: ArgumentFramework): number {
  let covered = 0;
  forEachMember(mask, (s) => {
    const ts = af.targetsOf[s];
    for (let k = 0; k < ts.length; k += 1) covered |= 1 << ts[k]!;
  });
  return covered;
}

function admissibleByMask(mask: number, af: ArgumentFramework): boolean {
  if (!conflictFreeByMask(mask, af)) return false;
  const covered = coveredMask(mask, af);
  let ok = true;
  forEachMember(mask, (a) => {
    if (!ok) return;
    const atk = af.attackersOf[a];
    for (let k = 0; k < atk.length; k += 1) {
      if (((covered >>> atk[k]!) & 1) !== 1) {
        ok = false;
        return;
      }
    }
  });
  return ok;
}

/** 完全集判定（前置条件：mask 已可采纳——只补「含所有防得住者」） */
function completeGivenAdmissibleMask(mask: number, af: ArgumentFramework): boolean {
  const covered = coveredMask(mask, af);
  for (let a = 0; a < af.size; a += 1) {
    if (((mask >>> a) & 1) === 1) continue;
    const atk = af.attackersOf[a];
    let defended = true;
    for (let k = 0; k < atk.length; k += 1) {
      if (((covered >>> atk[k]!) & 1) !== 1) {
        defended = false;
        break;
      }
    }
    if (defended) return false; // 防得住却不在集内 → 非完全
  }
  return true;
}

function stableByMask(mask: number, af: ArgumentFramework): boolean {
  if (!conflictFreeByMask(mask, af)) return false;
  const covered = coveredMask(mask, af);
  for (let a = 0; a < af.size; a += 1) {
    if (((mask >>> a) & 1) === 1) continue;
    if (((covered >>> a) & 1) !== 1) return false;
  }
  return true;
}

function popcount16(mask: number): number {
  let count = 0;
  let m = mask;
  while (m !== 0) {
    m &= m - 1;
    count += 1;
  }
  return count;
}

/** ⊆-极大过滤：按基数降序扫描，被已保留者包含的丢弃（位运算子集测试） */
function maximalMasks(masks: ReadonlyArray<number>): number[] {
  const sorted = [...masks].sort((x, y) => popcount16(y) - popcount16(x) || x - y);
  const kept: number[] = [];
  for (const m of sorted) {
    let contained = false;
    for (const k of kept) {
      if ((m & k) === m) {
        contained = true;
        break;
      }
    }
    if (!contained) kept.push(m);
  }
  return kept;
}

function compareMemberArrays(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** 掩码族 → 规范形态的外延列表（各外延升序，列表按字典序——跨实现可比） */
function masksToSortedSets(masks: ReadonlyArray<number>): number[][] {
  return masks.map(maskMembers).sort(compareMemberArrays);
}

/**
 * 无冲突集全枚举（独立集 DFS 引擎，R5 位掩码化）：
 * 冲突图 = 攻击关系对称化；无冲突性是遗传性质（前缀封闭），故升序
 * DFS 不漏不重地访问每个无冲突集恰一次——与暴力 2^n 全子集扫描
 * 是**两条独立路线**，在验证脚本中互为对照。
 *
 * R5 等价证明（位掩码化 vs 原 chosen.includes 版）: 冲突谓词
 * 「i 与已选集冲突」= (targets[i]∩chosen)∪(attackers[i]∩chosen) ≠ ∅
 * ⟺ conflictMask[i] & chosenMask ≠ 0（conflictMask = targets∪attackers
 * 的位掩码，chosenMask 随栈增量维护）——谓词恒等且 DFS 访问序不变，
 * 故输出枚举序列逐位相同，下游 preferred/stable/complete 全部不变。
 */
function conflictFreeMasksDfs(af: ArgumentFramework): number[] {
  const n = af.size;
  const conflictMask = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let m = 0;
    const ts = af.targetsOf[i];
    for (let k = 0; k < ts.length; k += 1) m |= 1 << ts[k]!;
    const atk = af.attackersOf[i];
    for (let k = 0; k < atk.length; k += 1) m |= 1 << atk[k]!;
    conflictMask[i] = m;
  }
  const out: number[] = [];
  let chosenMask = 0;
  const rec = (start: number): void => {
    out.push(chosenMask);
    for (let i = start; i < n; i += 1) {
      if ((conflictMask[i]! & chosenMask) !== 0) continue; // 与已选集冲突 → 剪枝
      chosenMask |= 1 << i;
      rec(i + 1);
      chosenMask &= ~(1 << i);
    }
  };
  rec(0);
  return out;
}

// ─────────────────────────── 外延族语义（n ≤ 16） ───────────────────────────

/**
 * 完全外延族：DFS 无冲突集 → 过滤可采纳 → 补「含所有防得住者」。
 * 每个完全外延 ⊇ grounded（grounded = 全体之交）。
 */
export function completeExtensions(af: ArgumentFramework): number[][] {
  requireEnumerable(af, 'completeExtensions');
  const masks: number[] = [];
  for (const mask of conflictFreeMasksDfs(af)) {
    if (admissibleByMask(mask, af) && completeGivenAdmissibleMask(mask, af)) masks.push(mask);
  }
  return masksToSortedSets(masks);
}

/**
 * 偏好外延族：⊆-极大的可采纳集（争议最大化的多世界裁决——每个外延
 * 是一个自洽立场，不同立场可互不包含）。
 */
export function preferredExtensions(af: ArgumentFramework): number[][] {
  requireEnumerable(af, 'preferredExtensions');
  const admissible: number[] = [];
  for (const mask of conflictFreeMasksDfs(af)) {
    if (admissibleByMask(mask, af)) admissible.push(mask);
  }
  return masksToSortedSets(maximalMasks(admissible));
}

/**
 * 稳定外延族：无冲突 + 攻击所有外部。经由定理「稳定 ⟹ 偏好」在偏好
 * 外延内过滤（与暴力全子集直扫互证）。可能为空（奇环等）——诚实报空。
 */
export function stableExtensions(af: ArgumentFramework): number[][] {
  requireEnumerable(af, 'stableExtensions');
  const masks = preferredExtensions(af)
    .map((e) => setToMask(e))
    .filter((m) => stableByMask(m, af));
  return masksToSortedSets(masks);
}

/** 暴力枚举对照报告（2^n 全子集直扫——验证脚本的独立真值源） */
export interface BruteForceReport {
  readonly size: number;
  /** 扫描子集数（= 2^n，退化检测锚点） */
  readonly subsetsChecked: number;
  readonly conflictFreeCount: number;
  readonly admissibleCount: number;
  readonly completeExtensions: ReadonlyArray<ReadonlyArray<number>>;
  readonly preferredExtensions: ReadonlyArray<ReadonlyArray<number>>;
  readonly stableExtensions: ReadonlyArray<ReadonlyArray<number>>;
  /** 所有完全外延之交（Dung 定理：= grounded——与不动点迭代互证） */
  readonly completeIntersection: ReadonlyArray<number>;
}

/**
 * bruteForceSemantics：对 0..2^n−1 每个子集独立打标（无冲突/可采纳/
 * 完全/稳定）， maximal 过滤得偏好族，完全族之交得基底外延对照值。
 * 与不动点迭代（groundedExtension）、独立集 DFS（preferredExtensions
 * 等）三条路线互不相同，供验证脚本两两对账。
 */
export function bruteForceSemantics(af: ArgumentFramework): BruteForceReport {
  requireEnumerable(af, 'bruteForceSemantics');
  const total = 1 << af.size;
  let conflictFreeCount = 0;
  let admissibleCount = 0;
  const completeMasks: number[] = [];
  const admissibleMasks: number[] = [];
  const stableMasks: number[] = [];
  for (let mask = 0; mask < total; mask += 1) {
    if (!conflictFreeByMask(mask, af)) continue;
    conflictFreeCount += 1;
    if (stableByMask(mask, af)) stableMasks.push(mask);
    if (admissibleByMask(mask, af)) {
      admissibleCount += 1;
      admissibleMasks.push(mask);
      if (completeGivenAdmissibleMask(mask, af)) completeMasks.push(mask);
    }
  }
  let intersection = total - 1;
  for (const m of completeMasks) intersection &= m;
  return {
    size: af.size,
    subsetsChecked: total,
    conflictFreeCount,
    admissibleCount,
    completeExtensions: masksToSortedSets(completeMasks),
    preferredExtensions: masksToSortedSets(maximalMasks(admissibleMasks)),
    stableExtensions: masksToSortedSets(stableMasks),
    completeIntersection: maskMembers(intersection),
  };
}

// ─────────────────────────── 接受查询（sceptical vs credulous） ───────────────────────────

/** 语义种类（const 对象 + 类型；不用 enum） */
export const EXTENSION_SEMANTICS = {
  grounded: 'grounded',
  complete: 'complete',
  preferred: 'preferred',
  stable: 'stable',
} as const;

export type ExtensionSemantics = keyof typeof EXTENSION_SEMANTICS;

/** 接受查询结果：疑信（所有外延都收）/ 轻信（存在外延收） */
export interface AcceptanceResult {
  readonly argument: number;
  readonly semantics: ExtensionSemantics;
  /** 该语义的外延族规模（stable 可能为 0——见 sceptical 约定） */
  readonly extensionsCount: number;
  /** a 出现在几个外延中 */
  readonly memberships: number;
  /** 轻信接受：∃E, a ∈ E */
  readonly credulous: boolean;
  /** 疑信接受：外延族非空 ∧ ∀E, a ∈ E（空外延族按 false 诚实返回，不做空洞真） */
  readonly sceptical: boolean;
}

/**
 * acceptance：疑信/轻信双口径接受查询。
 * - 轻信（credulous）：存在一个外延收 a——「有人能完整辩护它」；
 * - 疑信（sceptical）：所有外延都收 a——「任何立场下都站得住」；
 * - grounded 语义外延唯一，疑信 = 轻信；stable 族可为空，此时两者
 *   均 false（extensionsCount=0 供调用方分辨「无稳定外延」与「被拒绝」）。
 */
export function acceptance(
  argument: number,
  af: ArgumentFramework,
  semantics: ExtensionSemantics = 'preferred',
): AcceptanceResult {
  requireArgumentIndex(argument, af, 'acceptance');
  if (typeof semantics !== 'string' || !Object.prototype.hasOwnProperty.call(EXTENSION_SEMANTICS, semantics)) {
    throw new Error(`acceptance: 语义必须是 grounded/complete/preferred/stable 之一（收到 ${String(semantics)}）`);
  }
  let family: ReadonlyArray<ReadonlyArray<number>>;
  if (semantics === 'grounded') {
    family = [groundedExtension(af).extension];
  } else if (semantics === 'complete') {
    family = completeExtensions(af);
  } else if (semantics === 'preferred') {
    family = preferredExtensions(af);
  } else {
    family = stableExtensions(af);
  }
  let memberships = 0;
  for (const e of family) {
    if (e.includes(argument)) memberships += 1;
  }
  const extensionsCount = family.length;
  return {
    argument,
    semantics,
    extensionsCount,
    memberships,
    credulous: memberships > 0,
    sceptical: extensionsCount > 0 && memberships === extensionsCount,
  };
}

// ─────────────────────────── R5 进化: 价值型论证框架 VAF（Bench-Capon 2003） ───────────────────────────

/** 受众 = 价值偏好序（pref[k] = 排第 k 位的价值下标，最优先） */
export type Audience = ReadonlyArray<number>;

/** 价值型论证框架: 每条论证推崇一个价值，攻击是否奏效由受众的价值序裁决 */
export interface ValueFramework {
  /** 论证名（下标即位置; 唯一非空）*/
  readonly arguments: ReadonlyArray<string>;
  /** 价值名（唯一非空）*/
  readonly valueNames: ReadonlyArray<string>;
  /** values[i] = 论证 i 推崇的价值下标 */
  readonly values: ReadonlyArray<number>;
  /** 攻击对 [攻击者, 被攻击者]（去重升序——与 Dung AF 同口径）*/
  readonly attacks: ReadonlyArray<readonly [number, number]>;
  /** targetsOf[i]: i 攻击的论证下标（升序去重; 攻击边存在性的快速判定）*/
  readonly targetsOf: ReadonlyArray<ReadonlyArray<number>>;
  /** attackersOf[i]: 攻击 i 的论证下标（升序去重）*/
  readonly attackersOf: ReadonlyArray<ReadonlyArray<number>>;
  readonly size: number;
  readonly valueCount: number;
}

/** VAF 受众枚举护栏: 价值数 ≤ 6（受众 = 价值序全排列 ≤ 720 个）*/
export const VAF_MAX_VALUES = 6;

/**
 * 价值型框架构造（含合同校验）: 论证名/价值名唯一非空、values 下标合法、
 * 攻击对下标合法去重。
 */
export function valueFramework(
  args: ReadonlyArray<string>,
  valueNames: ReadonlyArray<string>,
  values: ReadonlyArray<number>,
  attacks: ReadonlyArray<readonly [number, number]>,
): ValueFramework {
  const seenArg = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`valueFramework: 论证名必须是非空字符串（第 ${i} 个收到 ${String(name)}）`);
    }
    if (seenArg.has(name)) throw new Error(`valueFramework: 论证名必须唯一（"${name}" 重复出现）`);
    seenArg.add(name);
  }
  const seenValue = new Set<string>();
  for (let v = 0; v < valueNames.length; v += 1) {
    const name = valueNames[v];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`valueFramework: 价值名必须是非空字符串（第 ${v} 个收到 ${String(name)}）`);
    }
    if (seenValue.has(name)) throw new Error(`valueFramework: 价值名必须唯一（"${name}" 重复出现）`);
    seenValue.add(name);
  }
  if (valueNames.length === 0) throw new Error('valueFramework: 价值表不能为空');
  if (values.length !== args.length) {
    throw new Error(`valueFramework: values 长度 ${values.length} ≠ 论证数 ${args.length}`);
  }
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isInteger(values[i]) || values[i]! < 0 || values[i]! >= valueNames.length) {
      throw new Error(`valueFramework: values[${i}]=${String(values[i])} 越界 [0, ${valueNames.length})`);
    }
  }
  // 攻击对合法性复用 argumentFramework 的合同校验（构造后取其规范化攻击表）
  const base = argumentFramework(args, attacks);
  return {
    arguments: [...args],
    valueNames: [...valueNames],
    values: [...values],
    attacks: base.attacks,
    targetsOf: base.targetsOf,
    attackersOf: base.attackersOf,
    size: base.size,
    valueCount: valueNames.length,
  };
}

/** 受众合法性: 恰为价值集的一个排列 */
function requireAudience(audience: Audience, vaf: ValueFramework, fn: string): void {
  if (audience.length !== vaf.valueCount) {
    throw new Error(`${fn}: 受众必须是 ${vaf.valueCount} 个价值的排列（收到 ${audience.length} 项）`);
  }
  const seen = new Set<number>();
  for (const v of audience) {
    if (!Number.isInteger(v) || v < 0 || v >= vaf.valueCount || seen.has(v)) {
      throw new Error(`${fn}: 受众必须是价值的无重复排列（收到 ${String(v)}）`);
    }
    seen.add(v);
  }
}

/** 受众眼中价值 v 的名次（小 = 更受偏好） */
function valueRank(audience: Audience, v: number): number {
  return audience.indexOf(v);
}

/**
 * 攻击 (a, b) 对受众是否**成功**（Bench-Capon 准则）:
 * 成功 ⟺ (a,b) 是攻击边 **且** 攻击者的价值不劣于被攻击者的价值
 * （value(b) ≻_audience value(a) 的攻击被受众免疫——「你攻击的理由在我
 * 价值序里更弱，攻击无效」）。非攻击对恒 false（全谓词，无前置合同）。
 */
export function attackSucceeds(attacker: number, target: number, vaf: ValueFramework, audience: Audience): boolean {
  requireArgumentIndex(attacker, vaf, 'attackSucceeds');
  requireArgumentIndex(target, vaf, 'attackSucceeds');
  requireAudience(audience, vaf, 'attackSucceeds');
  if (!vaf.targetsOf[attacker]!.includes(target)) return false; // 攻击边不存在 → 无所谓成功
  return valueRank(audience, vaf.values[attacker]!) <= valueRank(audience, vaf.values[target]!);
}

/** 受众诱导的 Dung AF: 只保留成功攻击（失败攻击被受众价值序消解）*/
export function inducedFramework(vaf: ValueFramework, audience: Audience): ArgumentFramework {
  requireAudience(audience, vaf, 'inducedFramework');
  const kept = vaf.attacks.filter(([a, b]) => attackSucceeds(a, b, vaf, audience));
  return argumentFramework([...vaf.arguments], kept.map(([a, b]) => [a, b] as [number, number]));
}

/** 全体受众（价值序全排列，字典序生成——确定性）*/
export function allAudiences(vaf: ValueFramework): Audience[] {
  if (vaf.valueCount > VAF_MAX_VALUES) {
    throw new Error(`allAudiences: 价值数 ${vaf.valueCount} > ${VAF_MAX_VALUES}（全排列护栏）`);
  }
  const perm = Array.from({ length: vaf.valueCount }, (_, i) => i);
  const out: Audience[] = [[...perm]];
  for (;;) {
    // 下一个字典序排列
    let k = -1;
    for (let i = perm.length - 2; i >= 0; i -= 1) {
      if (perm[i]! < perm[i + 1]!) {
        k = i;
        break;
      }
    }
    if (k === -1) break;
    let l = -1;
    for (let i = perm.length - 1; i > k; i -= 1) {
      if (perm[i]! > perm[k]!) {
        l = i;
        break;
      }
    }
    const tmp = perm[k]!;
    perm[k] = perm[l]!;
    perm[l] = tmp;
    for (let i = k + 1, j = perm.length - 1; i < j; i += 1, j -= 1) {
      const t = perm[i]!;
      perm[i] = perm[j]!;
      perm[j] = t;
    }
    out.push([...perm]);
  }
  return out;
}

/** Bench-Capon 双口径接受报告 */
export interface ValueAcceptance {
  /** 客观接受: 对**一切**受众都轻信接受（preferred 外延含之）*/
  readonly objectivelyAcceptable: ReadonlyArray<boolean>;
  /** 主观接受: 对**某些**受众轻信接受 */
  readonly subjectivelyAcceptable: ReadonlyArray<boolean>;
  /** 各受众的轻信接受矩阵（audienceIndex × argument）*/
  readonly byAudience: ReadonlyArray<ReadonlyArray<boolean>>;
  readonly audiencesChecked: number;
}

/**
 * 价值型裁决: 枚举全体受众（价值序全排列），逐受众取诱导 Dung AF 的
 * preferred 外延做轻信接受——
 *   客观接受 = ∀受众接受（任何价值观下都站得住的正典）;
 *   主观接受 = ∃受众接受（换个价值观就翻案的争议论证）。
 * 定理（返回值隐含的包含链）: 客观 ⊆ 主观; 无任何成功攻击者的论证
 * 至少主观接受（独自成集可扩展到极大可采纳集）。
 */
export function valueAcceptance(vaf: ValueFramework): ValueAcceptance {
  const audiences = allAudiences(vaf);
  if (vaf.size > MAX_ENUM_ARGUMENTS) {
    throw new Error(`valueAcceptance: 枚举型语义仅支持 ≤ ${MAX_ENUM_ARGUMENTS} 个论证（收到 ${vaf.size}）`);
  }
  const byAudience: boolean[][] = [];
  const objective = new Array<boolean>(vaf.size).fill(true);
  const subjective = new Array<boolean>(vaf.size).fill(false);
  for (const audience of audiences) {
    const family = preferredExtensions(inducedFramework(vaf, audience));
    const row = new Array<boolean>(vaf.size).fill(false);
    for (let a = 0; a < vaf.size; a += 1) {
      row[a] = family.some((e) => e.includes(a));
    }
    for (let a = 0; a < vaf.size; a += 1) {
      if (!row[a]) objective[a] = false;
      if (row[a]) subjective[a] = true;
    }
    byAudience.push(row);
  }
  return { objectivelyAcceptable: objective, subjectivelyAcceptable: subjective, byAudience, audiencesChecked: audiences.length };
}

/**
 * 随机 VAF（确定性）: n 论证、k 价值、攻击概率 p（对称化与否同
 * randomFramework 口径），价值指派均匀。mulberry32(seed) 行优先扫描。
 */
export function randomValueFramework(
  size: number,
  valueCount: number,
  attackProbability: number,
  seed: number,
  opts?: { selfAttacks?: boolean },
): ValueFramework {
  if (!Number.isInteger(size) || size < 0) throw new Error(`randomValueFramework: 论证数必须是非负整数（收到 ${String(size)}）`);
  if (!Number.isInteger(valueCount) || valueCount < 1 || valueCount > VAF_MAX_VALUES) {
    throw new Error(`randomValueFramework: 价值数必须是 1..${VAF_MAX_VALUES} 的整数（收到 ${String(valueCount)}）`);
  }
  if (!(attackProbability >= 0 && attackProbability <= 1)) {
    throw new Error(`randomValueFramework: 攻击概率必须在 [0,1]（收到 ${String(attackProbability)}）`);
  }
  const rng = mulberry32(seed);
  const names = Array.from({ length: size }, (_, i) => `a${i}`);
  const valueNames = Array.from({ length: valueCount }, (_, i) => `v${i}`);
  const values = Array.from({ length: size }, () => Math.floor(rng() * valueCount));
  const attacks: Array<[number, number]> = [];
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      if (i === j && opts?.selfAttacks !== true) continue;
      if (rng() < attackProbability) attacks.push([i, j]);
    }
  }
  return valueFramework(names, valueNames, values, attacks);
}

// ─────────────────────────── 展示工具 ───────────────────────────

/** 集合的可读形态：{a,c} / ∅（审计日志用） */
export function formatArgumentSet(S: ReadonlyArray<number>, af: ArgumentFramework): string {
  const set = normalizeSet(S, af, 'formatArgumentSet');
  if (set.length === 0) return '∅';
  const names = set.map((i) => af.arguments[i]);
  return `{${names.join(',')}}`;
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: src/core/deliberation.ts 深思内核（7.0）的辩论收束
 *    阶段与共生议会记录（symbiosis/runtime）——本内核是它们的
 *    「裁决语义」理论核：
 *    a) 辩论流程结束（7.0 的辩论轮次收束）后，把「结论 + 冲突对」
 *       编码为 ArgumentFramework：每个结论一条论证、每条「X 与 Y 不相容
 *       / X 推翻 Y 的前提」一条攻击边，然后按保守度选语义裁决：
 *       grounded = 只接受无争议辩护链（最保守、多项式、必存在）；
 *       preferred = 多世界裁决（每个外延一个自洽立场，供 64.0 的协调
 *       分布在立场间分配权重）；stable = 强硬裁决（可能不存在——
 *       诚实报空而非硬选，恰是「争议不可强裁」的数学信号）；
 *    b) acceptance() 直接回答「该结论疑信/轻信接受吗」：疑信接受才可
 *       写入共识账本；轻信接受可进「候选 + 附攻击图」队列待复辩；
 *       连轻信都不可接受的结论必须携带致败边（isAcceptable 的
 *       links 里 defenders 为空的攻击者）——拒绝第一次有了数学尸检
 *       报告；
 *    c) 复辩护（reinstatement）流程化：新证据到达 = 加攻击边后重跑
 *       grounded，trace 给出逐轮复活链（谁在第几轮被谁救回）。
 * 2. 缺省关闭旗标名: SymbiosisBridgeConfig 新增
 *     `argumentation?: { enabled?: boolean }`（缺省 false，影子计算，
 *     不改变主链路——与 62.0/63.0/64.0 旗标同款）。
 * 3. 挂载后改变的决策点：
 *    - 议会「多数票/权重加总」→「辩护链存在性」：一个结论被接受
 *      不再因为多少人投它，而因为它在攻击图上防得住；
 *    - 议会记录携带外延族（preferred 全列表）与每结论的
 *      memberships/extensionsCount——同一辩论的多世界立场第一次
 *      被显式保留而非强行归一；
 *    - 攻击图的构造必须可审计（每条边对应一条真实的反驳记录，
 *      不得由单方模型申报——防攻击图投毒：错误的边直接扭曲裁决）；
 *    - 未启用时行为与本内核加入前逐位一致（零漂移）。
 * 4. 成本注记: groundedExtension O(rounds·(n+m))、rounds ≤ n+1，
 *    任意规模可跑；complete/preferred/stable/bruteForce 是 2^n 枚举，
 *    护栏 MAX_ENUM_ARGUMENTS=16——议会结论数大时先做同侧聚类
 *    （把互相支持的主张合并为单论证）再入图；isAcceptable/谓词
 *    函数 O(度) 任意规模可内联到热路径。
 */
