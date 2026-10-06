/**
 * 61.0 稳定匹配内核 —— Gale–Shapley 延迟接受 + 稳定匹配格 + TTC 房屋交换核
 *
 * 动机: 32.0 最优指派是**单边意志**——收益矩阵给定，被指派方没有发言权；
 * 双向拍卖是**价格撮合**——偏好被压扁成出价。可 agent↔任务、模型↔租户的
 * 长期撮合里**双方各有偏好**: 强行指派的解中总有「阻挡对」(blocking
 * pair)——双方都更愿意抛开系统指派私奔的配对——协议被拆台的动机写在解
 * 本身里。稳定匹配问双边版本:
 *
 *   匹配 μ **稳定** ⟺ 不存在对 (p, r): p 相对 μ(p) 更喜欢 r，且 r 相对
 *   μ(r) 更喜欢 p —— 没有人有理由私奔，协议**自执行**。
 *
 * 数学:
 *   存在性 (Gale–Shapley 1962): 严格偏好下稳定匹配总存在——延迟接受
 *   构造性证明，O(n²)。求婚方沿自身偏好序逐位下移求婚，接收方「握最好、
 *   释其余」；一旦被拒永不再回头（候选集单调收缩 ⟹ 终止 ⟹ 稳定）。
 *
 *   格结构 (Conway–Knuth): 全体稳定匹配在逐分量支配序下构成**格**；
 *   求婚方发起得到格顶——求婚方在**一切**稳定匹配中逐分量最优、接收方
 *   逐分量最劣（接收方发起得格底）。「先开口者占优」是定理而非工程副
 *   作用——latticeExtremes 把两个极值同时摆上桌面供显式权衡。
 *
 *   求婚方无策略性 (Gale–Sotomayor): 谎报偏好不可能让求婚方得到比诚实
 *   更好的伙伴（DSIC）——求婚占优的另一面是求婚方无需策略。
 *
 *   房屋市场 (Shapley–Scarf 1974): 带初始产权的不可分品交换——
 *   Top-Trading-Cycles 指向图求圈清圈；TTC 结果在核中（没有联盟能带着
 *   自己的产权私下重分而阻挡）。口径要分清（inCore 双口径实现）:
 *     弱核 = 联盟内**人人严格**改善才算阻挡——可含多个分配；
 *     强核 = 人人**弱**改善且至少一人严格改善即阻挡——严格偏好下是
 *     **单点** (Roth–Postlewaite)，且恰为 TTC 输出。
 *
 * 验证锚点: ①教科书 3×3/4×4 已知解对照（4×4 呈格钻石: 恰 4 个稳定匹配，
 *   中间两个不可比）②随机实例（种子化 n=6~8）×60: 双向 GS 输出全部无阻挡
 *   对 ③格序逐对: 求婚方最优 ≽ 接收方最优（接收方反向同时成立）
 *   ④allStableMatchings 枚举全稳定、两极值都在枚举集内 ⑤DSIC 抽样
 *   550 次完整排列谎报: 真实名次无一改善 ⑥TTC 文献例精确对照 + 核
 *   成员 + 强核单点性（枚举一切 n! 分配: 强核中恰 1 个 = TTC 输出）。
 *
 * R5 进化（第五轮·世界性升级，四轴）:
 *   数学轴——多对一医院/居民匹配（容量版 DA，Roth–Sotomayor 响应式偏好
 *   口径）: 医院 = 带容量接收方，对**个体**居民持严格排名（响应式: 满员时
 *   与最差在编者比较，更优则换握）。居民发起 → 居民最优; 医院发起（医院
 *   向居民逐位求婚直到补满名额）→ 医院最优。稳定性 = 无阻挡对 (r, h):
 *   r 愿去（单身或更爱 h）且 h 收得起（有空位或愿踢最差在编者）——
 *   响应式偏好下成对稳定 ⟹ 群稳定（Roth 1984，无需另查联盟）。
 *   Rural Hospital 定理（Roth 1984/1986）: 同一市场的**所有**稳定匹配中，
 *   未匹配居民集合逐人相同、每家医院的实际占用（空缺数）逐院相同——
 *   「名额空在哪」是市场结构性质，不随稳定解的选择而变。ruralHospitalCheck
 *   同时跑双向容量 DA 并对账这两组不变量。
 *   性能轴——空闲求婚方队列化（deferredAcceptanceQueued）: 批次版每轮
 *   filter+sort 整个空闲表（O(F log F)/轮 + 中间分配），队列版用栈驱动、
 *   均摊 O(1)/求婚、零中间分配。等价性 = GS 求婚序不变性定理
 *   （Gusfield–Irving: 求婚方最优稳定匹配与求婚顺序无关）+ 指针论证
 *   （每位求婚方 next 指针终值 = 终伴名次+1，故 matching/inverse/
 *   proposals 与批次版逐位相同，仅轮计数语义不同）; 实测耗时与批次版
 *   持平（求婚循环主导），收益为最坏情形每轮再排序的消除（诚实口径）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 公共类型 ───────────────────────────

export interface StableMatchingProblem {
  /** 求婚方名 → 对接收方的严格偏好序（最喜欢在前；截断处之后 = 不可接受）*/
  proposers: Readonly<Record<string, ReadonlyArray<string>>>;
  /** 接收方名 → 对求婚方的严格偏好序 */
  receivers: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface DeferredAcceptanceResult {
  /** 求婚方 → 接收方（只含已匹配对）*/
  matching: Record<string, string>;
  /** 接收方 → 求婚方（逆映射）*/
  inverse: Record<string, string>;
  /** 延迟接受轮数（每轮 = 仍可求婚的自由求婚方各求婚一次的批次）*/
  rounds: number;
  /** 总求婚次数 */
  proposals: number;
}

export interface StabilityCheck {
  stable: boolean;
  /** 阻挡对（空 ⟺ 稳定）。证明携带: 不稳定时给出全部「私奔对」证人 */
  blockingPairs: Array<[string, string]>;
}

export interface LatticeExtremes {
  /** 格顶: 求婚方最优稳定匹配（求婚方发起 GS = 全体稳定匹配的 join）*/
  proposerOptimal: Record<string, string>;
  /** 格底: 接收方最优稳定匹配（接收方发起 GS，转回求婚方口径 = meet）*/
  receiverOptimal: Record<string, string>;
  /** 顶 ≠ 底 ⟺ 稳定匹配不止一个（格非平凡）*/
  differ: boolean;
  roundsProposer: number;
  roundsReceiver: number;
}

export interface AllStableMatchingsResult {
  matchings: Array<Record<string, string>>;
  count: number;
  /** 扫过的候选匹配总数（= Π(|偏好_i|+1) 的完整枚举空间）*/
  scanned: number;
}

export interface HousingMarketProblem {
  /** agent → 初始房产（一一对应: 每套房产恰有一个 owner）*/
  owners: Readonly<Record<string, string>>;
  /** agent → 完整严格的房产偏好序（每套房产恰出现一次）*/
  housePrefs: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface TopTradingCyclesResult {
  /** agent → 最终房产（完整偏好下人人有房）*/
  allocation: Record<string, string>;
  /** 逐轮清空的交易圈。圈 [a₁,…,a_k]: a_i 得到 a_{i+1} 的初始房产（a_k 得 a₁ 的）；长度 1 = 自留 */
  cycles: string[][];
  rounds: number;
}

export interface CoreCheck {
  inCore: boolean;
  /** 违例联盟（无则 undefined）: 联盟 + 其初始产权的内部分配，按所选口径人人达标 */
  violation?: { coalition: string[]; reallocation: Record<string, string> };
}

export interface CoreCheckOptions {
  /**
   * true = 强核口径: 联盟内人人弱改善且至少一人严格改善即算阻挡——
   * 严格偏好下强核是单点且 = TTC 输出（Roth–Postlewaite）。
   * 缺省 false = 弱核口径: 须人人严格改善才算阻挡——可含多个分配。
   */
  strong?: boolean;
}

// ─────────────────────────── 内部: 双边市场归一化 ───────────────────────────

/** 纯数字样式名（"0"、"12"…）会让 Object.keys 走整数槽排序，破坏确定性——拒绝 */
const INTEGER_LIKE = /^(0|[1-9][0-9]*)$/;

interface NormalizedProblem {
  proposerNames: string[];
  receiverNames: string[];
  pIdx: Map<string, number>;
  rIdx: Map<string, number>;
  /** 求婚方 i 的可接受接收方（偏好序，索引化）*/
  pList: number[][];
  /** 接收方 j 的可接受求婚方 */
  rList: number[][];
  /** pRank[i][j] = 接收方 j 在求婚方 i 眼中的名次（0 最优；不可接受 = ∞）*/
  pRank: number[][];
  rRank: number[][];
}

function assertPlainObject(value: unknown, who: string, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${who}: ${label} 必须是「名字 → 偏好序」的对象（而非数组）`);
  }
}

function assertAgentName(name: string, who: string, label: string): void {
  if (name.length === 0) throw new Error(`${who}: ${label} 名字不能为空`);
  if (INTEGER_LIKE.test(name)) {
    throw new Error(`${who}: ${label} 名字「${name}」不能是纯数字样式（Object 键序确定性要求）`);
  }
}

function firstDuplicate(names: string[]): string | undefined {
  const seen = new Set<string>();
  for (const nm of names) {
    if (seen.has(nm)) return nm;
    seen.add(nm);
  }
  return undefined;
}

/** 偏好序索引化 + 严格性/已知性校验 */
function indexPrefs(
  record: Record<string, unknown>,
  names: string[],
  otherIdx: Map<string, number>,
  sideLabel: string,
  otherLabel: string,
  who: string,
): number[][] {
  return names.map((name) => {
    const list = record[name];
    if (!Array.isArray(list)) {
      throw new Error(`${who}: ${sideLabel} ${name} 的偏好序必须是字符串数组`);
    }
    const seen = new Set<string>();
    const out: number[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error(`${who}: ${sideLabel} ${name} 的偏好项必须是非空字符串`);
      }
      const j = otherIdx.get(entry);
      if (j === undefined) {
        throw new Error(`${who}: ${sideLabel} ${name} 的偏好里出现未知${otherLabel}「${entry}」`);
      }
      if (seen.has(entry)) {
        throw new Error(`${who}: ${sideLabel} ${name} 的偏好必须严格（「${entry}」重复出现）`);
      }
      seen.add(entry);
      out.push(j);
    }
    return out;
  });
}

/** 偏好表 → 名次矩阵（不可接受 = Infinity，比较语义下自动「永不接受」）*/
function rankMatrix(lists: number[][], width: number): number[][] {
  return lists.map((list) => {
    const row = new Array<number>(width).fill(Infinity);
    list.forEach((j, k) => {
      row[j] = k;
    });
    return row;
  });
}

function normalizeProblem(problem: StableMatchingProblem, who: string): NormalizedProblem {
  if (problem === null || typeof problem !== 'object') {
    throw new Error(`${who}: problem 必须是 { proposers, receivers } 对象`);
  }
  const src = problem as { proposers?: unknown; receivers?: unknown };
  assertPlainObject(src.proposers, who, 'proposers');
  assertPlainObject(src.receivers, who, 'receivers');
  const proposerNames = Object.keys(src.proposers as Record<string, unknown>);
  const receiverNames = Object.keys(src.receivers as Record<string, unknown>);
  for (const p of proposerNames) assertAgentName(p, who, '求婚方');
  for (const r of receiverNames) assertAgentName(r, who, '接收方');
  const pIdx = new Map(proposerNames.map((nm, i) => [nm, i] as const));
  const rIdx = new Map(receiverNames.map((nm, i) => [nm, i] as const));
  const pList = indexPrefs(src.proposers as Record<string, unknown>, proposerNames, rIdx, '求婚方', '接收方', who);
  const rList = indexPrefs(src.receivers as Record<string, unknown>, receiverNames, pIdx, '接收方', '求婚方', who);
  return {
    proposerNames,
    receiverNames,
    pIdx,
    rIdx,
    pList,
    rList,
    pRank: rankMatrix(pList, receiverNames.length),
    rRank: rankMatrix(rList, proposerNames.length),
  };
}

// ─────────────────────────── Gale–Shapley 延迟接受 ───────────────────────────

/**
 * 延迟接受主循环（求婚方发起 → 求婚方最优）。
 *
 * 轮语义: 每一轮，所有仍自由且偏好未耗尽的求婚方**各求婚一次**（教科书
 * 批次口径）；被释放者下一轮再婚。被拒不可逆（候选集单调收缩）⟹ 终止，
 * 终止时无阻挡对 ⟹ 稳定；每方拿到的都是「向其求过婚者中最好」⟹ 求婚方
 * 最优（格顶）。
 */
function runDeferredAcceptance(nP: NormalizedProblem): DeferredAcceptanceResult {
  const n = nP.proposerNames.length;
  const next = new Array<number>(n).fill(0); // 各求婚方下一次求婚位置
  const heldBy = new Array<number>(nP.receiverNames.length).fill(-1); // 接收方当前持有
  let free: number[] = [];
  for (let i = 0; i < n; i += 1) free.push(i);
  let rounds = 0;
  let proposals = 0;
  for (;;) {
    const batch = free.filter((i) => next[i] < nP.pList[i].length).sort((a, b) => a - b);
    if (batch.length === 0) break;
    rounds += 1;
    const nextFree: number[] = [];
    for (const p of batch) {
      const r = nP.pList[p][next[p]];
      next[p] += 1;
      proposals += 1;
      const rRankP = nP.rRank[r][p];
      if (rRankP === Infinity) {
        nextFree.push(p); // 不可接受: 直接拒
        continue;
      }
      const cur = heldBy[r];
      if (cur === -1) {
        heldBy[r] = p; // 空手则暂握
      } else if (rRankP < nP.rRank[r][cur]) {
        heldBy[r] = p; // 更爱则换握
        nextFree.push(cur); // 旧欢释放
      } else {
        nextFree.push(p); // 不如现任
      }
    }
    free = nextFree;
  }
  const matching: Record<string, string> = {};
  const inverse: Record<string, string> = {};
  heldBy.forEach((p, r) => {
    if (p !== -1) {
      matching[nP.proposerNames[p]] = nP.receiverNames[r];
      inverse[nP.receiverNames[r]] = nP.proposerNames[p];
    }
  });
  return { matching, inverse, rounds, proposals };
}

/**
 * Gale–Shapley 延迟接受（求婚方发起 = 求婚方最优稳定匹配）。
 *
 * 偏好可截断（截断处之后不可接受，双方独立截断）；不可接受的求婚直接被
 * 拒。输出稳定匹配是构造性定理: 存在、O(n²)、且是格顶。
 */
export function deferredAcceptance(problem: StableMatchingProblem): DeferredAcceptanceResult {
  return runDeferredAcceptance(normalizeProblem(problem, 'deferredAcceptance'));
}

/**
 * 稳定匹配格的两极值。
 *
 * 求婚方发起 → 格顶（求婚方逐分量最优 / 接收方逐分量最劣）；接收方发起
 * → 格底。同一个实例的两个方向对照，把「谁先开口谁占优」变成可检查量。
 */
export function latticeExtremes(problem: StableMatchingProblem): LatticeExtremes {
  const top = runDeferredAcceptance(normalizeProblem(problem, 'latticeExtremes'));
  const bottomRun = runDeferredAcceptance(
    normalizeProblem({ proposers: problem.receivers, receivers: problem.proposers } as StableMatchingProblem, 'latticeExtremes'),
  );
  const bottom: Record<string, string> = {};
  for (const [r, p] of Object.entries(bottomRun.matching)) bottom[p] = r;
  const differ =
    Object.keys(top.matching).length !== Object.keys(bottom).length ||
    !Object.keys(top.matching).every((k) => bottom[k] === top.matching[k]);
  return {
    proposerOptimal: top.matching,
    receiverOptimal: bottom,
    differ,
    roundsProposer: top.rounds,
    roundsReceiver: bottomRun.rounds,
  };
}

/**
 * 阻挡对检查器（证明携带）。
 *
 * matching: 求婚方 → 接收方（只含已匹配对；缺席 = 单身）。逐对扫描互相
 * 可接受的 (p, r): 双方都比现状更愿意私奔 → 阻挡对。空表 ⟺ 稳定——稳定
 * 性不靠声称，靠检查。非法匹配（未知名 / 非互相可接受 / 非单射）显式 throw。
 */
export function isStable(matching: Readonly<Record<string, string>>, problem: StableMatchingProblem): StabilityCheck {
  const nP = normalizeProblem(problem, 'isStable');
  const pPartner = new Array<number>(nP.proposerNames.length).fill(-1);
  const rPartner = new Array<number>(nP.receiverNames.length).fill(-1);
  for (const [p, r] of Object.entries(matching)) {
    if (typeof r !== 'string') throw new Error(`isStable: 匹配值必须是字符串（${p} → ${String(r)}）`);
    const pi = nP.pIdx.get(p);
    const ri = nP.rIdx.get(r);
    if (pi === undefined) throw new Error(`isStable: 匹配里的未知求婚方「${p}」`);
    if (ri === undefined) throw new Error(`isStable: 匹配里的未知接收方「${r}」`);
    if (nP.pRank[pi][ri] === Infinity) throw new Error(`isStable: ${p} 与 ${r} 不是可接受对（${p} 的偏好不含 ${r}）`);
    if (nP.rRank[ri][pi] === Infinity) throw new Error(`isStable: ${p} 与 ${r} 不是可接受对（${r} 的偏好不含 ${p}）`);
    if (rPartner[ri] !== -1) throw new Error(`isStable: 匹配不是单射（${r} 被重复指配）`);
    pPartner[pi] = ri;
    rPartner[ri] = pi;
  }
  const blockingPairs: Array<[string, string]> = [];
  for (let i = 0; i < nP.proposerNames.length; i += 1) {
    for (const r of nP.pList[i]) {
      if (pPartner[i] === r) continue;
      const cur = pPartner[i];
      if (cur !== -1 && nP.pRank[i][cur] < nP.pRank[i][r]) continue; // p 更爱现任
      if (nP.rRank[r][i] === Infinity) continue; // r 不接受 p
      const curR = rPartner[r];
      if (curR !== -1 && nP.rRank[r][curR] < nP.rRank[r][i]) continue; // r 更爱现任
      blockingPairs.push([nP.proposerNames[i], nP.receiverNames[r]]); // 双方都愿私奔
    }
  }
  return { stable: blockingPairs.length === 0, blockingPairs };
}

/**
 * 全体稳定匹配枚举（验证锚点用；建议 n ≤ 6）。
 *
 * 递归枚举所有互相可接受的部分单射匹配，逐个过 isStable。枚举空间
 * Π(|偏好_i|+1) 超 1e6 时拒绝（+1 = 各方「保持单身」分支）。
 */
export function allStableMatchings(problem: StableMatchingProblem): AllStableMatchingsResult {
  const nP = normalizeProblem(problem, 'allStableMatchings');
  let estimate = 1;
  for (const list of nP.pList) {
    estimate *= list.length + 1;
    if (estimate > 1_000_000) {
      throw new Error('allStableMatchings: 枚举空间 > 1e6（建议 n ≤ 6 或截断偏好）');
    }
  }
  const matchings: Array<Record<string, string>> = [];
  const assign = new Array<number>(nP.proposerNames.length).fill(-1);
  const used = new Array<boolean>(nP.receiverNames.length).fill(false);
  let scanned = 0;
  const rec = (i: number): void => {
    if (i === nP.proposerNames.length) {
      scanned += 1;
      const candidate: Record<string, string> = {};
      nP.proposerNames.forEach((name, k) => {
        const r = assign[k];
        if (r !== -1) candidate[name] = nP.receiverNames[r];
      });
      if (isStable(candidate, problem).stable) matchings.push(candidate);
      return;
    }
    assign[i] = -1; // 单身分支
    rec(i + 1);
    for (const r of nP.pList[i]) {
      if (used[r] || nP.rRank[r][i] === Infinity) continue; // 被占 / 对方不接受
      used[r] = true;
      assign[i] = r;
      rec(i + 1);
      used[r] = false;
    }
    assign[i] = -1;
  };
  rec(0);
  return { matchings, count: matchings.length, scanned };
}

// ─────────────────────────── 房屋市场: 归一化 ───────────────────────────

interface NormalizedHousing {
  agentNames: string[];
  houseNames: string[];
  aIdx: Map<string, number>;
  /** agent i → 初始房产 idx */
  ownerHouse: number[];
  /** 房产 j → owner agent idx */
  ownerAgent: number[];
  /** agent i 的完整严格房产偏好（索引化）*/
  prefIdx: number[][];
  /** prefRank[i][j] = 房产 j 在 agent i 眼中的名次 */
  prefRank: number[][];
}

function normalizeHousing(problem: HousingMarketProblem, who: string): NormalizedHousing {
  if (problem === null || typeof problem !== 'object') {
    throw new Error(`${who}: problem 必须是 { owners, housePrefs } 对象`);
  }
  const src = problem as { owners?: unknown; housePrefs?: unknown };
  assertPlainObject(src.owners, who, 'owners');
  assertPlainObject(src.housePrefs, who, 'housePrefs');
  const agentNames = Object.keys(src.owners as Record<string, unknown>);
  for (const a of agentNames) assertAgentName(a, who, 'agent');
  const ownerRecord = src.owners as Record<string, unknown>;
  const houseNames = agentNames.map((a) => {
    const h = ownerRecord[a];
    if (typeof h !== 'string' || h.length === 0) {
      throw new Error(`${who}: agent ${a} 的初始房产必须是非空字符串`);
    }
    return h;
  });
  const dupHouse = firstDuplicate(houseNames);
  if (dupHouse !== undefined) {
    throw new Error(`${who}: 房产「${dupHouse}」被多个 agent 持有（产权必须一一对应）`);
  }
  const aIdx = new Map(agentNames.map((nm, i) => [nm, i] as const));
  const hIdx = new Map(houseNames.map((nm, i) => [nm, i] as const));
  const prefRecord = src.housePrefs as Record<string, unknown>;
  const prefAgents = Object.keys(prefRecord);
  if (prefAgents.length !== agentNames.length || !prefAgents.every((a) => aIdx.has(a))) {
    throw new Error(`${who}: housePrefs 的键必须与 owners 的键（agent 全集）一致`);
  }
  const prefIdx: number[][] = agentNames.map((a) => {
    const list = prefRecord[a];
    if (!Array.isArray(list)) throw new Error(`${who}: agent ${a} 的房产偏好必须是数组`);
    if (list.length !== houseNames.length) {
      throw new Error(`${who}: agent ${a} 的偏好必须完整（长 ${houseNames.length}，得到 ${list.length}）`);
    }
    const seen = new Set<string>();
    const row: number[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string') throw new Error(`${who}: agent ${a} 的偏好项必须是字符串`);
      const hi = hIdx.get(entry);
      if (hi === undefined) throw new Error(`${who}: agent ${a} 的偏好里出现未知房产「${entry}」`);
      if (seen.has(entry)) throw new Error(`${who}: agent ${a} 的偏好必须严格（「${entry}」重复）`);
      seen.add(entry);
      row.push(hi);
    }
    return row;
  });
  const ownerHouse = houseNames.map(() => -1);
  agentNames.forEach((a, i) => {
    const h = (src.owners as Record<string, string>)[a];
    ownerHouse[i] = hIdx.get(h) as number;
  });
  const ownerAgent = new Array<number>(houseNames.length).fill(-1);
  ownerHouse.forEach((h, i) => {
    ownerAgent[h] = i;
  });
  return { agentNames, houseNames, aIdx, ownerHouse, ownerAgent, prefIdx, prefRank: rankMatrix(prefIdx, houseNames.length) };
}

// ─────────────────────────── Top-Trading-Cycles ───────────────────────────

/**
 * Top-Trading-Cycles（Shapley–Scarf 1974 房屋市场）。
 *
 * 每轮: 存活 agent 各指向自己的存活首选房产，房产指向其 owner——函数图
 * 必含圈，本轮把**所有**圈同时清空（圈内 agent 依次得到下一圈员初始房
 * 产权），移出市场，重复。O(n²)。
 *
 * 定理: 结果在核中（弱核与强核皆属——无联盟可携产权私下改进）；严格
 * 偏好下强核是单点（Roth–Postlewaite）——TTC 给出**唯一**强核分配。
 */
export function topTradingCycles(problem: HousingMarketProblem): TopTradingCyclesResult {
  const nH = normalizeHousing(problem, 'topTradingCycles');
  const n = nH.agentNames.length;
  const alive = new Array<boolean>(n).fill(true);
  const aliveHouse = new Array<boolean>(nH.houseNames.length).fill(true);
  const allocation: Record<string, string> = {};
  const cycles: string[][] = [];
  let rounds = 0;
  let remaining = n;
  while (remaining > 0) {
    rounds += 1;
    const top: number[] = [];
    for (let i = 0; i < n; i += 1) {
      let pick = -1;
      if (alive[i]) {
        for (const h of nH.prefIdx[i]) {
          if (aliveHouse[h]) {
            pick = h;
            break;
          }
        }
        if (pick === -1) throw new Error('topTradingCycles: 内部错误——存活 agent 无存活首选（不变量被破坏）');
      }
      top.push(pick);
    }
    // 函数图找圈: 0=未访 / 1=当前路径 / 2=已处理（死路或已入圈）
    const mark = new Array<number>(n).fill(0);
    const executed: string[][] = [];
    for (let i = 0; i < n; i += 1) {
      if (!alive[i] || mark[i] !== 0) continue;
      const path: number[] = [];
      let cur = i;
      let found: string[] | undefined;
      for (;;) {
        if (!alive[cur] || mark[cur] === 2) break; // 死路（指向已处理/已移出者）
        if (mark[cur] === 1) {
          const start = path.indexOf(cur);
          found = path.slice(start).map((a) => nH.agentNames[a]); // 闭合成圈
          break;
        }
        mark[cur] = 1;
        path.push(cur);
        cur = nH.ownerAgent[top[cur]]; // agent → 首选房产 → 其 owner
      }
      for (const a of path) mark[a] = 2;
      if (found !== undefined) executed.push(found);
    }
    if (executed.length === 0) {
      throw new Error('topTradingCycles: 指向图无圈（有限函数图必含圈——不变量被破坏）');
    }
    for (const cyc of executed) {
      cycles.push(cyc);
      const k = cyc.length;
      for (let t = 0; t < k; t += 1) {
        const buyer = nH.aIdx.get(cyc[t]);
        const seller = nH.aIdx.get(cyc[(t + 1) % k]);
        if (buyer === undefined || seller === undefined) {
          throw new Error('topTradingCycles: 内部错误——圈成员不在 agent 名单');
        }
        allocation[cyc[t]] = nH.houseNames[nH.ownerHouse[seller]]; // 得下一圈员的初始房产
        alive[buyer] = false;
        aliveHouse[nH.ownerHouse[buyer]] = false; // 连人带产权一起移出
        remaining -= 1;
      }
    }
  }
  return { allocation, cycles, rounds };
}

/**
 * 核成员检查（Shapley–Scarf 口径，联盟枚举 2ⁿ × 联盟内排列）。
 *
 * allocation 在核中 ⟺ 不存在联盟 S 与其**初始产权**的内部分配阻挡之。
 * 弱核（缺省）: S 内人人严格改善才阻挡；强核（strong: true）: 人人弱
 * 改善且至少一人严格改善即阻挡——严格偏好下强核单点 = TTC 输出。
 * 违例时给出证人（联盟 + 重分配）。n ≤ 10。
 */
export function inCore(allocation: Readonly<Record<string, string>>, problem: HousingMarketProblem, options?: CoreCheckOptions): CoreCheck {
  const strong = options?.strong === true;
  const nH = normalizeHousing(problem, 'inCore');
  const n = nH.agentNames.length;
  if (n > 10) throw new Error('inCore: 联盟枚举 2ⁿ × 排列——仅支持 n ≤ 10');
  const allocHouse = new Array<number>(n).fill(-1);
  const usedHouse = new Array<boolean>(nH.houseNames.length).fill(false);
  for (const [a, h] of Object.entries(allocation)) {
    const ai = nH.aIdx.get(a);
    if (ai === undefined) throw new Error(`inCore: 分配里的未知 agent「${a}」`);
    if (typeof h !== 'string') throw new Error(`inCore: 分配值必须是字符串（${a} → ${String(h)}）`);
    const hi = nH.houseNames.indexOf(h);
    if (hi === -1) throw new Error(`inCore: 分配里的未知房产「${h}」`);
    if (usedHouse[hi]) throw new Error(`inCore: 分配不是单射（房产「${h}」被重复分配）`);
    usedHouse[hi] = true;
    allocHouse[ai] = hi;
  }
  const rankNow = (i: number): number => (allocHouse[i] === -1 ? Infinity : nH.prefRank[i][allocHouse[i]]);
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const members: number[] = [];
    for (let i = 0; i < n; i += 1) if ((mask & (1 << i)) !== 0) members.push(i);
    // 单人联盟也阻挡: agent 总能收回自己的初始房产——分配严格劣于自有房产
    // 即被 {i} 阻挡（个体理性）；等于自有房产无严格改善、不阻挡。
    const houses = members.map((i) => nH.ownerHouse[i]);
    const perm = new Array<number>(members.length).fill(-1);
    const taken = new Array<boolean>(houses.length).fill(false);
    let strictGain = 0;
    let reallocation: Record<string, string> | undefined;
    const rec = (d: number): boolean => {
      if (d === members.length) {
        if (strong && strictGain === 0) return false; // 强核要求至少一人严格改善
        const re: Record<string, string> = {};
        for (let t = 0; t < members.length; t += 1) re[nH.agentNames[members[t]]] = nH.houseNames[houses[perm[t]]];
        reallocation = re;
        return true;
      }
      for (let t = 0; t < houses.length; t += 1) {
        if (taken[t]) continue;
        const rank = nH.prefRank[members[d]][houses[t]];
        const cur = rankNow(members[d]);
        if (strong ? rank > cur : rank >= cur) continue; // 弱核须严格改善；强核允许持平
        taken[t] = true;
        perm[d] = t;
        const gained = rank < cur;
        if (gained) strictGain += 1;
        if (rec(d + 1)) return true;
        if (gained) strictGain -= 1;
        taken[t] = false;
        perm[d] = -1;
      }
      return false;
    };
    if (rec(0) && reallocation !== undefined) {
      return { inCore: false, violation: { coalition: members.map((i) => nH.agentNames[i]), reallocation } };
    }
  }
  return { inCore: true };
}

// ─────────────────────────── 种子化随机实例 ───────────────────────────

/** mulberry32 —— 32 位确定性 PRNG（文件内自带: 零依赖零 I/O，同种子同序列）*/
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items: readonly string[], rnd: () => number): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 随机完备严格偏好双边市场（求婚/接收各 n 方，名 P1..Pn / R1..Rn；同种子同实例）*/
export function randomMatchingProblem(n: number, seed: number): StableMatchingProblem {
  if (!Number.isInteger(n) || n < 0 || n > 256) throw new Error('randomMatchingProblem: 需要 0 ≤ n ≤ 256 的整数');
  const rnd = mulberry32(seed);
  const pNames = Array.from({ length: n }, (_, i) => `P${i + 1}`);
  const rNames = Array.from({ length: n }, (_, i) => `R${i + 1}`);
  const proposers: Record<string, string[]> = {};
  const receivers: Record<string, string[]> = {};
  for (const p of pNames) proposers[p] = shuffled(rNames, rnd);
  for (const r of rNames) receivers[r] = shuffled(pNames, rnd);
  return { proposers, receivers };
}

/** 随机房屋市场（agent A1..An 初始持有 H1..Hn，偏好洗牌；同种子同实例）*/
export function randomHousingMarket(n: number, seed: number): HousingMarketProblem {
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('randomHousingMarket: 需要 1 ≤ n ≤ 256 的整数');
  const rnd = mulberry32(seed);
  const agents = Array.from({ length: n }, (_, i) => `A${i + 1}`);
  const houses = Array.from({ length: n }, (_, i) => `H${i + 1}`);
  const owners: Record<string, string> = {};
  const housePrefs: Record<string, string[]> = {};
  agents.forEach((a, i) => {
    owners[a] = houses[i];
    housePrefs[a] = shuffled(houses, rnd);
  });
  return { owners, housePrefs };
}

// ─────────────────────────── R5 进化 A: 空闲求婚方队列化（性能轴） ───────────────────────────

export interface QueuedDeferredAcceptanceResult {
  /** 求婚方 → 接收方（与批次版 deferredAcceptance 逐位相同——见等价性论证）*/
  matching: Record<string, string>;
  inverse: Record<string, string>;
  /** 出队次数（每次出队处理一个空闲求婚方的一次求婚; ≠ 批次轮数）*/
  dequeues: number;
  /** 总求婚次数（与批次版相同——每位求婚方指针终值不变）*/
  proposals: number;
}

/**
 * 队列化延迟接受（性能进化; 结果与 deferredAcceptance 等价）。
 *
 * 批次版每轮对整个空闲表 filter+sort（O(F log F) + 中间数组分配/轮）——
 * 空闲表里「偏好已耗尽」的成员轮轮被扫又被丢。队列版用显式栈驱动:
 * 被释放者/被拒者回栈、耗尽者出队即弃、栈空即止——每求婚平摊 O(1)、
 * 零中间分配。实测完备/截断偏好负载与批次版耗时持平（求婚循环本身
 * 主导），收益是最坏情形每轮再排序的消除与零分配——不是常数加速。
 *
 * 等价性（不是近似，是定理）:
 * ① GS 求婚序不变性（Gusfield–Irving）: 求婚方最优稳定匹配与求婚顺序无关
 *    ——两版 matching 逐位相同;
 * ② 指针论证: 每位求婚方沿自身偏好序逐位前进、绝不回头，终态指针
 *    next[p] = 终伴名次 + 1（或耗尽）——终伴不变 ⟹ 指针终值不变 ⟹ 总求婚
 *    次数不变。两版仅「轮计数」语义不同（批次轮 vs 出队次数）。
 */
export function deferredAcceptanceQueued(problem: StableMatchingProblem): QueuedDeferredAcceptanceResult {
  const nP = normalizeProblem(problem, 'deferredAcceptanceQueued');
  const n = nP.proposerNames.length;
  const next = new Array<number>(n).fill(0);
  const heldBy = new Array<number>(nP.receiverNames.length).fill(-1);
  const stack: number[] = [];
  for (let i = n - 1; i >= 0; i -= 1) stack.push(i); // 倒序入栈 → 首出队序 = 0,1,2,…（与批次版首个批次一致）
  let dequeues = 0;
  let proposals = 0;
  while (stack.length > 0) {
    const p = stack.pop() as number;
    dequeues += 1;
    if (next[p] >= nP.pList[p].length) continue; // 偏好耗尽: 保持单身，出队不回栈
    const r = nP.pList[p][next[p]];
    next[p] += 1;
    proposals += 1;
    const rRankP = nP.rRank[r][p];
    if (rRankP === Infinity) {
      stack.push(p); // 不可接受: 回栈等下一次出队再婚
      continue;
    }
    const cur = heldBy[r];
    if (cur === -1) {
      heldBy[r] = p; // 空手则暂握
    } else if (rRankP < nP.rRank[r][cur]) {
      heldBy[r] = p; // 更爱则换握
      stack.push(cur); // 旧欢回栈
    } else {
      stack.push(p); // 不如现任: 回栈
    }
  }
  const matching: Record<string, string> = {};
  const inverse: Record<string, string> = {};
  heldBy.forEach((p, r) => {
    if (p !== -1) {
      matching[nP.proposerNames[p]] = nP.receiverNames[r];
      inverse[nP.receiverNames[r]] = nP.proposerNames[p];
    }
  });
  return { matching, inverse, dequeues, proposals };
}

// ─────────────────────────── R5 进化 B: 多对一 医院/居民匹配（数学轴） ───────────────────────────

/** 医院（接收方）规格: 招收名额 + 对居民个体的严格偏好序（截断处之后 = 不可接受）*/
export interface HospitalSpec {
  /** 招收名额（≥ 1）*/
  readonly capacity: number;
  /** 对居民的严格偏好序（最喜欢在前）——响应式偏好的基础: 医院在集合间的比较由个体排名导出 */
  readonly ranking: ReadonlyArray<string>;
}

/** 多对一医院/居民匹配问题（Roth–Sotomayor 响应式偏好口径）*/
export interface HospitalResidentsProblem {
  /** 居民名 → 对医院的严格偏好序（截断处之后 = 不可接受）*/
  residents: Readonly<Record<string, ReadonlyArray<string>>>;
  /** 医院名 → { capacity, ranking } */
  hospitals: Readonly<Record<string, HospitalSpec>>;
}

/** 容量版 DA 发起方选择 */
export interface CapacityDaOptions {
  /** 'residents'（缺省）→ 居民最优稳定匹配; 'hospitals' → 医院最优稳定匹配 */
  proposer?: 'residents' | 'hospitals';
}

export interface CapacityMatchingResult {
  /** 居民 → 医院（只含已匹配者）*/
  assignment: Record<string, string>;
  /** 医院 → 已招收居民（按该医院的偏好序输出——确定性形态）*/
  hospitalAssignments: Record<string, string[]>;
  /** 医院 → 实招人数 */
  filled: Record<string, number>;
  /** 医院 → 空缺 = capacity − filled */
  vacancy: Record<string, number>;
  /** 未匹配居民（按输入序）*/
  unmatchedResidents: string[];
  /** 批次轮数（每轮 = 所有可行动的自由求婚方各求婚一次）*/
  rounds: number;
  /** 总求婚次数 */
  proposals: number;
}

export interface ManyToOneStabilityCheck {
  stable: boolean;
  /** 阻挡对 [居民, 医院]: 居民愿去且医院收得起（空位或愿换最差在编者）*/
  blockingPairs: Array<[string, string]>;
}

/** Rural Hospital 定理对账报告（双向容量 DA 的不变量检查）*/
export interface RuralHospitalCheck {
  /** 定理成立: 未匹配集合逐人相同 ∧ 每院占用逐院相同 */
  holds: boolean;
  unmatchedIdentical: boolean;
  occupancyIdentical: boolean;
  residentOptimal: CapacityMatchingResult;
  hospitalOptimal: CapacityMatchingResult;
}

interface NormalizedHR {
  residentNames: string[];
  hospitalNames: string[];
  /** 居民 i 的可接受医院（偏好序，索引化）*/
  resList: number[][];
  /** 医院 j 的可接受居民（偏好序，索引化）*/
  hospList: number[][];
  /** resRank[i][h] = 医院h 在居民i 眼中的名次（∞ = 不可接受）*/
  resRank: number[][];
  /** hospRank[h][i] = 居民i 在医院h 眼中的名次（∞ = 不可接受）*/
  hospRank: number[][];
  capacity: number[];
}

function normalizeHospitalResidents(problem: HospitalResidentsProblem, who: string): NormalizedHR {
  if (problem === null || typeof problem !== 'object') {
    throw new Error(`${who}: problem 必须是 { residents, hospitals } 对象`);
  }
  const src = problem as { residents?: unknown; hospitals?: unknown };
  assertPlainObject(src.residents, who, 'residents');
  assertPlainObject(src.hospitals, who, 'hospitals');
  const residentNames = Object.keys(src.residents as Record<string, unknown>);
  const hospitalNames = Object.keys(src.hospitals as Record<string, unknown>);
  for (const r of residentNames) assertAgentName(r, who, '居民');
  for (const h of hospitalNames) assertAgentName(h, who, '医院');
  if (residentNames.length > 0 && hospitalNames.length === 0) {
    throw new Error(`${who}: 有居民而无医院（医院侧至少需要一个键）`);
  }
  const rIdx = new Map(residentNames.map((nm, i) => [nm, i] as const));
  const hIdx = new Map(hospitalNames.map((nm, i) => [nm, i] as const));
  const resList = indexPrefs(src.residents as Record<string, unknown>, residentNames, hIdx, '居民', '医院', who);
  const hospRecord = src.hospitals as Record<string, unknown>;
  const capacity: number[] = [];
  const hospList: number[][] = hospitalNames.map((name) => {
    const spec = hospRecord[name];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${who}: 医院 ${name} 的规格必须是 { capacity, ranking } 对象`);
    }
    const { capacity: cap, ranking } = spec as { capacity?: unknown; ranking?: unknown };
    if (!Number.isInteger(cap) || (cap as number) < 1) {
      throw new Error(`${who}: 医院 ${name} 的 capacity 必须是 ≥1 的整数（收到 ${String(cap)}）`);
    }
    if (!Array.isArray(ranking)) {
      throw new Error(`${who}: 医院 ${name} 的 ranking 必须是居民名字符串数组`);
    }
    capacity.push(cap as number);
    return indexPrefs({ [name]: ranking } as Record<string, unknown>, [name], rIdx, '医院', '居民', `${who}: 医院 ${name}`)[0];
  });
  return {
    residentNames,
    hospitalNames,
    resList,
    hospList,
    resRank: rankMatrix(resList, hospitalNames.length),
    hospRank: rankMatrix(hospList, residentNames.length),
    capacity,
  };
}

/** 医院 j 当前在编者中最差者（名次最大; 空编返回 -1）*/
function worstHolder(held: readonly number[], hospRankRow: readonly number[]): number {
  let worst = -1;
  let worstRank = -1;
  for (const r of held) {
    const rank = hospRankRow[r];
    if (rank > worstRank) {
      worstRank = rank;
      worst = r;
    }
  }
  return worst;
}

function assembleCapacityResult(nH: NormalizedHR, holderOfResident: ReadonlyArray<number>): CapacityMatchingResult {
  const assignment: Record<string, string> = {};
  const hospitalAssignments: Record<string, string[]> = {};
  const filled: Record<string, number> = {};
  const vacancy: Record<string, number> = {};
  const unmatchedResidents: string[] = [];
  const heldByHospital: number[][] = nH.hospitalNames.map(() => []);
  holderOfResident.forEach((h, i) => {
    if (h !== -1) {
      assignment[nH.residentNames[i]] = nH.hospitalNames[h];
      heldByHospital[h].push(i);
    } else {
      unmatchedResidents.push(nH.residentNames[i]);
    }
  });
  nH.hospitalNames.forEach((name, h) => {
    heldByHospital[h].sort((a, b) => nH.hospRank[h][a] - nH.hospRank[h][b]); // 按医院偏好序输出
    hospitalAssignments[name] = heldByHospital[h].map((i) => nH.residentNames[i]);
    filled[name] = heldByHospital[h].length;
    vacancy[name] = nH.capacity[h] - heldByHospital[h].length;
  });
  return { assignment, hospitalAssignments, filled, vacancy, unmatchedResidents, rounds: 0, proposals: 0 };
}

/**
 * 容量版延迟接受（多对一医院/居民匹配）。
 *
 * 居民发起（缺省）: 与一对一 GS 同构——居民沿偏好序下移求婚，医院「握前
 * capacity 好、释其余」: 空编即暂握; 满编则与最差在编者（响应式比较）换
 * 握或拒绝。被拒不可逆 ⟹ 终止 ⟹ 无阻挡对（稳定）。
 *
 * 医院发起（proposer: 'hospitals'）: 医院沿自身排名向居民求婚直到补满
 * 名额; 居民「握最好、释其余」，被释放的医院回到求婚队列——产出医院最优
 * 稳定匹配（格顶对偶方向）。
 */
export function capacityDeferredAcceptance(
  problem: HospitalResidentsProblem,
  options?: CapacityDaOptions,
): CapacityMatchingResult {
  const proposer = options?.proposer ?? 'residents';
  if (proposer !== 'residents' && proposer !== 'hospitals') {
    throw new Error(`capacityDeferredAcceptance: proposer 必须是 'residents' 或 'hospitals'（收到 ${String(proposer)}）`);
  }
  const nH = normalizeHospitalResidents(problem, 'capacityDeferredAcceptance');
  const nR = nH.residentNames.length;
  const nHos = nH.hospitalNames.length;
  const holderOfResident = new Array<number>(nR).fill(-1);
  const filled = new Array<number>(nHos).fill(0);
  let rounds = 0;
  let proposals = 0;

  if (proposer === 'residents') {
    const next = new Array<number>(nR).fill(0);
    const held: number[][] = nH.hospitalNames.map(() => []);
    let free: number[] = [];
    for (let i = 0; i < nR; i += 1) free.push(i);
    for (;;) {
      const batch = free.filter((i) => next[i] < nH.resList[i].length).sort((a, b) => a - b);
      if (batch.length === 0) break;
      rounds += 1;
      const nextFree: number[] = [];
      for (const r of batch) {
        const h = nH.resList[r][next[r]];
        next[r] += 1;
        proposals += 1;
        if (nH.hospRank[h][r] === Infinity) {
          nextFree.push(r); // 医院不接受: 直接拒
          continue;
        }
        if (filled[h] < nH.capacity[h]) {
          held[h].push(r); // 空编即暂握
          filled[h] += 1;
        } else {
          const worst = worstHolder(held[h], nH.hospRank[h]);
          if (nH.hospRank[h][r] < nH.hospRank[h][worst]) {
            held[h][held[h].indexOf(worst)] = r; // 换握更优
            nextFree.push(worst); // 最差在编者释放
          } else {
            nextFree.push(r);
          }
        }
      }
      free = nextFree;
    }
    for (let h = 0; h < nHos; h += 1) for (const r of held[h]) holderOfResident[r] = h;
  } else {
    const ptr = new Array<number>(nHos).fill(0);
    for (;;) {
      const batch: number[] = [];
      for (let h = 0; h < nHos; h += 1) {
        if (filled[h] < nH.capacity[h] && ptr[h] < nH.hospList[h].length) batch.push(h);
      }
      if (batch.length === 0) break;
      rounds += 1;
      for (const h of batch) {
        const r = nH.hospList[h][ptr[h]];
        ptr[h] += 1;
        proposals += 1;
        if (nH.resRank[r][h] === Infinity) continue; // 居民不接受该医院: 医院下次出指向下一位
        const cur = holderOfResident[r];
        if (cur === -1) {
          holderOfResident[r] = h; // 居民空手则暂握
          filled[h] += 1;
        } else if (nH.resRank[r][h] < nH.resRank[r][cur]) {
          holderOfResident[r] = h; // 居民更爱则换握
          filled[h] += 1;
          filled[cur] -= 1; // 旧医院释放一个名额（下轮批次自动回到求婚队列）
        }
        // 否则被拒: 医院名额仍在，下轮指向下一位居民
      }
    }
  }
  const result = assembleCapacityResult(nH, holderOfResident);
  result.rounds = rounds;
  result.proposals = proposals;
  return result;
}

/**
 * 多对一阻挡对检查器（证明携带）。
 *
 * 阻挡对 (r, h): ①r 愿去（单身，或 h 严格优于现编）②h 收得起（有空位，
 * 或 r 严格优于其最差在编者）③双方互相可接受。响应式偏好下「无阻挡对」
 * 即稳定性（Roth: 成对稳定 ⟹ 群稳定）。非法指派（未知名 / 超容量 /
 * 非互相可接受）显式 throw。
 */
export function isStableManyToOne(
  assignment: Readonly<Record<string, string>>,
  problem: HospitalResidentsProblem,
): ManyToOneStabilityCheck {
  const nH = normalizeHospitalResidents(problem, 'isStableManyToOne');
  const nR = nH.residentNames.length;
  const assigned = new Array<number>(nR).fill(-1);
  const membersOf: number[][] = nH.hospitalNames.map(() => []);
  for (const [r, h] of Object.entries(assignment)) {
    const ri = nH.residentNames.indexOf(r);
    const hi = nH.hospitalNames.indexOf(h);
    if (ri === -1) throw new Error(`isStableManyToOne: 指派里的未知居民「${r}」`);
    if (typeof h !== 'string' || hi === -1) throw new Error(`isStableManyToOne: 指派里的未知医院「${String(h)}」`);
    if (assigned[ri] !== -1) throw new Error(`isStableManyToOne: 居民「${r}」被重复指配`);
    if (nH.resRank[ri][hi] === Infinity) throw new Error(`isStableManyToOne: ${r} 与 ${h} 不是可接受对（${r} 的偏好不含 ${h}）`);
    if (nH.hospRank[hi][ri] === Infinity) throw new Error(`isStableManyToOne: ${r} 与 ${h} 不是可接受对（${h} 的排名不含 ${r}）`);
    assigned[ri] = hi;
    membersOf[hi].push(ri);
  }
  nH.hospitalNames.forEach((_, hi) => {
    if (membersOf[hi].length > nH.capacity[hi]) {
      throw new Error(`isStableManyToOne: 医院「${nH.hospitalNames[hi]}」超容量（${membersOf[hi].length} > ${nH.capacity[hi]}）`);
    }
  });
  const blockingPairs: Array<[string, string]> = [];
  for (let i = 0; i < nR; i += 1) {
    const cur = assigned[i];
    for (const h of nH.resList[i]) {
      if (cur === h) continue;
      if (cur !== -1 && nH.resRank[i][cur] < nH.resRank[i][h]) continue; // 居民更爱现编
      if (nH.hospRank[h][i] === Infinity) continue; // 医院不接受该居民
      if (membersOf[h].length < nH.capacity[h]) {
        blockingPairs.push([nH.residentNames[i], nH.hospitalNames[h]]); // 空编即阻挡
        continue;
      }
      const worst = worstHolder(membersOf[h], nH.hospRank[h]);
      if (nH.hospRank[h][worst] > nH.hospRank[h][i]) {
        blockingPairs.push([nH.residentNames[i], nH.hospitalNames[h]]); // 愿踢最差在编者
      }
    }
  }
  return { stable: blockingPairs.length === 0, blockingPairs };
}

/**
 * Rural Hospital 定理对账（Roth 1984/1986）: 同一市场的所有稳定匹配中
 * ①未匹配居民集合逐人相同 ②每家医院实招人数（空缺）逐院相同。
 * 双向容量 DA 给出稳定匹配格的两端，两端不变 ⟹ 全体稳定匹配不变
 * （不变量对格顶/格底成立即对一切中间成员成立——两端是逐分量极值）。
 */
export function ruralHospitalCheck(problem: HospitalResidentsProblem): RuralHospitalCheck {
  const residentOptimal = capacityDeferredAcceptance(problem, { proposer: 'residents' });
  const hospitalOptimal = capacityDeferredAcceptance(problem, { proposer: 'hospitals' });
  const unmatchedIdentical =
    JSON.stringify([...residentOptimal.unmatchedResidents].sort()) === JSON.stringify([...hospitalOptimal.unmatchedResidents].sort());
  const occupancyIdentical = Object.keys(residentOptimal.filled).every(
    (h) => residentOptimal.filled[h] === hospitalOptimal.filled[h],
  );
  return { holds: unmatchedIdentical && occupancyIdentical, unmatchedIdentical, occupancyIdentical, residentOptimal, hospitalOptimal };
}

/** 随机医院/居民市场（居民 D1..Dn、医院 H1..Hm，容量 1..maxCapacity 均匀; 同种子同实例）*/
export function randomHospitalResidentsProblem(
  nResidents: number,
  nHospitals: number,
  seed: number,
  options?: { maxCapacity?: number },
): HospitalResidentsProblem {
  if (!Number.isInteger(nResidents) || nResidents < 0 || nResidents > 256) {
    throw new Error('randomHospitalResidentsProblem: 需要 0 ≤ 居民数 ≤ 256 的整数');
  }
  if (!Number.isInteger(nHospitals) || nHospitals < 0 || nHospitals > 256) {
    throw new Error('randomHospitalResidentsProblem: 需要 0 ≤ 医院数 ≤ 256 的整数');
  }
  const maxCapacity = options?.maxCapacity ?? 3;
  if (!Number.isInteger(maxCapacity) || maxCapacity < 1 || maxCapacity > 256) {
    throw new Error('randomHospitalResidentsProblem: maxCapacity 必须是 1..256 的整数');
  }
  const rnd = mulberry32(seed);
  const residentNames = Array.from({ length: nResidents }, (_, i) => `D${i + 1}`);
  const hospitalNames = Array.from({ length: nHospitals }, (_, i) => `H${i + 1}`);
  const residents: Record<string, string[]> = {};
  const hospitals: Record<string, HospitalSpec> = {};
  for (const r of residentNames) residents[r] = shuffled(hospitalNames, rnd);
  for (const h of hospitalNames) {
    hospitals[h] = {
      capacity: 1 + Math.floor(rnd() * maxCapacity),
      ranking: shuffled(residentNames, rnd),
    };
  }
  return { residents, hospitals };
}

/* ── 接线建议 ──
 * 1) 共生市场撮合: agent↔任务 双边偏好撮合——现有双向拍卖（价格撮合）之外
 *    的偏好撮合升级。deferredAcceptance(任务方求婚) 产出无阻挡对指派，
 *    「没有 agent+任务 对愿意私奔脱离系统」成为可检查性质（isStable 带
 *    阻挡对证人，可只对越界对告警）。
 * 2) 模型↔租户长期指派: 租户偏好（质量/延迟/成本）与模型偏好（负载/配额/
 *    亲和）各自成严格序；latticeExtremes 同场给出「租户最优」与「模型
 *    最优」两个极值——挂载方显式选择格中位置（或折中），而非隐式偏袒一侧。
 * 3) TTC: 带产权的存量资源互易（退役模型租约回收再分配、预留容量重排）
 *    ——核成员 = 没有子联盟能拿自己的产权私下重分而改进；inCore 双口径
 *    （弱核/强核）可对既有分配做独立审计。
 * 建议旗标: kernels.stableMatching.enabled（缺省 false——未挂载零介入）。
 * 挂载后改变的决策点: 任务分派从「评分 top-k 竞得」改为延迟接受撮合；
 * 长期指派从静态配置改为带稳定证书的周期重撮合（先 isStable 查旧匹配的
 * 阻挡对增量，仅在有阻挡对时触发——增量式，避免无谓重排）。
 */
