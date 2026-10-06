/**
 * 85.0 符号求解内核 —— DPLL 完备 SAT 求解与精确 #SAT 模型计数
 *
 * 动机: 判断层至今只能回答「连续量」的问题——置信度多高、期望回报多少、
 * 方差多大；而「离散约束是否可行」这类布尔问题无处安放：计划生成器给出
 * 的 DAG 计划，资源互斥/依赖冲突在动手前就能静态判死，却要等到执行中才
 * 暴露；任务分派的硬约束（互斥、容量、技能门槛）只能靠贪心试错。15.0
 * 运行时验证管「执行中的时序」（LTLf 监视、事后追责），本内核是其静态
 * 姊妹篇——管「动手前的可行性」：把离散约束编码为 CNF，在 0/1 指派的
 * 有限空间里做完备裁决，并精确量化可行指派的总数。
 *
 * 数学:
 * 1. DPLL（Davis–Putnam–Logemann–Loveland 1962）完备搜索：子句集
 *    {c₁..cₘ}（文字 = ±变元）上循环——单位传播（unit propagation 至
 *    不动点：单文字子句 c=(l) 强制 l 真；满足子句删除、假文字剥离）→
 *    纯文字消去（变元只以单一极性出现时按该极性定型，保持可满足性）→
 *    分支（MOM 启发：最短活动子句中字频最大的文字；平局取最小编号变元；
 *    seed 提供时用 mulberry32 轻抖动）→ 冲突回跳（非时序回溯到学子句的
 *    断言层，而非逐层倒退）→ 学子句（1UIP-lite：沿本决策层最近指派的
 *    文字反复与 reason 子句消解，留下唯一层内文字作断言字）。
 *    完备性：分支树有限（n 个变元二叉穷尽），回跳只是非时序地剪掉已证明
 *    无解的子树——穷尽后 UNSAT 判定可靠；SAT 时返回可代入验证的模型。
 * 2. #SAT 精确模型计数（Birnbaum–Lozinskii 组件分解式 DPLL 计数）：
 *    #F = 2^(自由变元数) × Π_组件 #Fᵢ（不相连变元组件独立计数相乘）；
 *    分支和规则 #F = #F|x=T + #F|x=F；单位传播保持计数（被强制文字的
 *    乘数为 1）。注意：纯文字消去对计数**不保持**——(x∨y) 中 x 纯，
 *    但 #((x∨y)) = 3 ≠ 2 = #((x∨y)|x=T)——故计数路径禁用纯文字，而
 *    可满足性路径可用。二者的分野是本内核的一个正确性细节。
 * 3. 随机 k-SAT 相变（Cheeseman–Kanefsky–Taylor；k=3 时 m/n ≈ 4.267）：
 *    最难实例的集中区，作为验证的对抗采样区（不是顺手，是专挑硬的）。
 *
 * 验证锚点（scripts/verify-symbolic-solver.mjs）:
 *   ① 手工公式 SAT/UNSAT 逐一对照（含单元链 decisions=0/propagations=3、
 *      纯文字案例、空子句、自由变元）——DPLL / 暴力枚举 / #SAT 三方一致；
 *   ② 鸽笼 PHP(3,2) 与 PHP(4,3)：DPLL 判 UNSAT 与 2ⁿ 暴力枚举一致，
 *      decisions/conflicts/learned 全部 > 0（回跳与学子句真实介入）；
 *   ③ 相变区 n=14、m/n≈4.26、50 种子：DPLL 与暴力枚举 100% 一致，SAT
 *      实例模型代入通过；同种子两次调用逐位复现；
 *   ④ 种植解随机 SAT：种植解与 DPLL 模型均代入满足全部子句；
 *   ⑤ #SAT：n≤16 随机公式精确计数 = 暴力 2ⁿ 枚举（1e-12 逐位一致），
 *      组件相乘与自由变元乘数各有手工锚点；
 *   ⑥ 单位传播不动点：传播到无单元子句，传播数与手工推演逐项一致，
 *      冲突子句原样携带。
 *
 * 确定性: 无 I/O、无时钟；随机源仅文件内 mulberry32(seed)（randomKSat /
 *   plantedSat 工厂与 dpllSolve 的可选分支抖动）；同输入（含 seed）同输出。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】搜索序进化的两把新刀（均保持 DPLL 完备性——分支树
 *    仍有限、回跳只剪已证无解子树，只是「先试哪支」更聪明）：
 *    · 相位保存（phase saving，Moskewicz et al. 2001 / MiniSat 谱系）：
 *      每个变元记住**最后一次被指派的极性**，重分支时先试保存相位——
 *      冲突学到的「好相位」跨回溯保留，UNSAT 证明与 SAT 模型搜索都
 *      显著提速（搜索序改变，判定/完备性不变）；
 *    · VSIDS 分支（Moskewicz et al. 2001）：冲突驱动活动度——学子句
 *      中出现的变元活动度 +1，全部活动度按 0.95/冲突 几何衰减，「最近
 *      冲突的变元」优先分支；活动度全零时回落 MOM。与相位保存正交
 *      组合（VSIDS 选变元、保存相位定极性 = MiniSat 的经典配置）。
 *
 * A2【性能进化】计数文字传播引擎（counted literals，Jeroslow–Wang
 *    计数式子句状态）：每子句维护 [未指派文字出现数 nUnass, 真文字
 *    出现数 nTrue]，变元指派/撤销沿出现表（occurrence list）增量
 *    更新——传播扫描里「满足/冲突/单元」判定全部 O(1)，不再逐文字
 *    重扫全库。**逐位等价**：扫描仍按子句索引序、首个单元/冲突子句
 *    与 scan 引擎相同（同一不动点、同一 trail 序、同一学子句与账单）
 *    ——verify-r5 以 200+ 种子对照 sat/model/decisions/propagations/
 *    conflicts/learned/pureLiterals 全等；缺省即 counted（快且零漂移），
 *    engine='scan' 保留原全扫描路径作对照与审计。
 *
 * A3【数值稳健】活动度几何衰减用「阈值重标定」防下溢（max > 1e100
 *    时全体除以 max——活动度只参与比较，比值不变，变元序确定不变）；
 *    重复文字的计数按**出现次数**计（与 scan 引擎的逐文字扫描口径
 *    逐位一致）。
 *
 * A4【性质测试】① 引擎等价：200+ 种子（相变区 3-SAT + 鸽笼 + 种植解）
 *    counted 与 scan 全字段逐位一致；② 完备性保持：phaseSaving/
 *    vsids 开启时判定与暴力枚举一致、SAT 模型代入通过、UNSAT 与
 *    scan 一致；③ 确定性：同输入两次调用逐位复现（全部引擎×启发
 *    组合）；④ 计数不变式：nUnass+nTrue ≤ 子句长度恒成立
 *    （verify-r5-planning.mjs）。
 */

// ─────────────────────────── 确定性 PRNG ───────────────────────────

/** mulberry32——随机工厂与可选分支抖动的唯一随机源（同 seed 逐位复现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── CNF 模型与校验 ───────────────────────────

/**
 * 合取范式（CNF）：子句 = 文字的析取（number[]），公式 = 子句的合取。
 * 文字 = ±变元（+v 表示 v 真，−v 表示 v 假）；0 不是文字（DIMACS 的子句
 * 终止符）。变元编号 1..numVars；空子句 [] 表示恒假（公式立即 UNSAT）。
 */
export interface Cnf {
  clauses: number[][];
  /** 变元数 n（所有 |lit| ≤ n） */
  numVars: number;
}

/** 文字 → 变元编号 */
function varOf(lit: number): number {
  return lit > 0 ? lit : -lit;
}

/** Cnf 全量校验（显式 throw；所有入口共用） */
function validateCnf(cnf: Cnf, who: string): void {
  if (cnf === null || typeof cnf !== 'object') throw new Error(`${who}: 需传入 Cnf { clauses, numVars }`);
  if (!Array.isArray(cnf.clauses)) throw new Error(`${who}: clauses 需为 number[][]`);
  if (!Number.isInteger(cnf.numVars) || cnf.numVars < 0) {
    throw new Error(`${who}: numVars=${String(cnf.numVars)} 需为非负整数`);
  }
  let ci = 0;
  for (const clause of cnf.clauses) {
    if (!Array.isArray(clause)) throw new Error(`${who}.clauses[${ci}]: 需为 number[]`);
    let li = 0;
    for (const lit of clause) {
      if (typeof lit !== 'number' || !Number.isInteger(lit) || lit === 0) {
        throw new Error(`${who}.clauses[${ci}][${li}]: 文字 ${String(lit)} 需为非 0 整数`);
      }
      if (Math.abs(lit) > cnf.numVars) {
        throw new Error(`${who}.clauses[${ci}][${li}]: 文字 ${lit} 越界（numVars=${String(cnf.numVars)}）`);
      }
      li += 1;
    }
    ci += 1;
  }
}

// ─────────────────────────── DIMACS lite 解析 ───────────────────────────

/**
 * 轻量 DIMACS 解析：'c' 行注释 / 空行 / '%' 行跳过；'p cnf <vars> <clauses>'
 * 头（至多一行；缺省时 numVars = 最大 |文字|）；整数 token 流以 0 终结子句
 * （一行多子句、一子句跨行均可）；EOF 处未闭合的末子句容忍收尾（lite）。
 * p 行声明变元数后出现越界文字 → 显式 throw。
 */
export function parseDimacsLite(s: string): Cnf {
  if (typeof s !== 'string') throw new Error('parseDimacsLite: 需传入字符串');
  const clauses: number[][] = [];
  let current: number[] = [];
  let numVars = -1;
  const lines = s.split(/\r?\n/);
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!.trim();
    if (line === '' || line.startsWith('c') || line.startsWith('%')) continue;
    if (line.startsWith('p')) {
      const m = /^p\s+cnf\s+(\d+)\s+(\d+)$/.exec(line);
      if (m === null) throw new Error(`parseDimacsLite: 第 ${li + 1} 行 p 行格式需为 "p cnf <vars> <clauses>"`);
      if (numVars >= 0) throw new Error(`parseDimacsLite: 第 ${li + 1} 行重复的 p 行`);
      numVars = Number(m[1]);
      continue;
    }
    for (const tok of line.split(/\s+/)) {
      if (!/^[+-]?\d+$/.test(tok)) throw new Error(`parseDimacsLite: 第 ${li + 1} 行非法文字 "${tok}"`);
      const v = Number(tok);
      if (v === 0) {
        clauses.push(current);
        current = [];
      } else {
        current.push(v);
      }
    }
  }
  if (current.length > 0) clauses.push(current);
  if (numVars < 0) {
    let mx = 0;
    for (const clause of clauses) for (const lit of clause) if (Math.abs(lit) > mx) mx = Math.abs(lit);
    numVars = mx;
  } else {
    let ci = 0;
    for (const clause of clauses) {
      let li = 0;
      for (const lit of clause) {
        if (Math.abs(lit) > numVars) {
          throw new Error(`parseDimacsLite: 第 ${ci}.${li} 个子句文字 ${lit} 越界（p 行声明 ${numVars} 变元）`);
        }
        li += 1;
      }
      ci += 1;
    }
  }
  return { clauses, numVars };
}

// ─────────────────────────── 单位传播（独立导出） ───────────────────────────

/** unitPropagate 的结果：指派不动点 + 传播轨迹 + 冲突证明子句 */
export interface PropagationOutcome {
  /** 输入 partial 与全部传播结果的并（var → 值） */
  assignment: ReadonlyMap<number, boolean>;
  /** 本次新传播的文字（按传播顺序，+v/-v 形式；确定性） */
  propagated: readonly number[];
  /** 传播步数 = propagated.length */
  propagations: number;
  /** 传播中发现全假子句（空子句化的子句） */
  conflict: boolean;
  /** 冲突子句原样携带（未冲突为 null）——机器可查的冲突证明 */
  conflictClause: readonly number[] | null;
}

/**
 * 单位传播至不动点（独立于求解器的最小传播原语）：
 * 反复扫描——子句在 partial 下满足则跳过；全假则冲突（携带原子句返回）；
 * 恰有一个未指派文字则该文字强制为真（记一次传播）。直到无单元子句且无
 * 冲突。确定性：每轮取子句序中第一个单元子句。
 */
export function unitPropagate(
  partial: ReadonlyMap<number, boolean>,
  clauses: readonly (readonly number[])[],
): PropagationOutcome {
  if (!(partial instanceof Map)) throw new Error('unitPropagate: partial 需为 Map<number, boolean>');
  if (!Array.isArray(clauses)) throw new Error('unitPropagate: clauses 需为 number[][]');
  const assignment = new Map<number, boolean>();
  for (const [v, val] of partial) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`unitPropagate: 部分指派含非法变元 ${String(v)}`);
    if (typeof val !== 'boolean') throw new Error(`unitPropagate: 变元 ${v} 的值 ${String(val)} 需为 boolean`);
    assignment.set(v, val);
  }
  let ci = 0;
  for (const clause of clauses) {
    if (!Array.isArray(clause)) throw new Error(`unitPropagate.clauses[${ci}]: 需为 number[]`);
    let li = 0;
    for (const lit of clause) {
      if (typeof lit !== 'number' || !Number.isInteger(lit) || lit === 0) {
        throw new Error(`unitPropagate.clauses[${ci}][${li}]: 文字 ${String(lit)} 需为非 0 整数`);
      }
      li += 1;
    }
    ci += 1;
  }
  const work: number[][] = clauses.map((c) => [...c]);
  const propagated: number[] = [];
  for (;;) {
    let unitLit = 0;
    for (const clause of work) {
      let satisfied = false;
      let count = 0;
      let unit = 0;
      for (const lit of clause) {
        const val = assignment.get(varOf(lit));
        if (val === undefined) {
          count += 1;
          unit = lit;
          if (count > 1) break;
        } else if (val === lit > 0) {
          satisfied = true;
          break;
        }
      }
      if (satisfied) continue;
      if (count === 0) {
        return { assignment, propagated, propagations: propagated.length, conflict: true, conflictClause: [...clause] };
      }
      if (count === 1 && unitLit === 0) unitLit = unit;
    }
    if (unitLit === 0) break;
    assignment.set(varOf(unitLit), unitLit > 0);
    propagated.push(unitLit);
  }
  return { assignment, propagated, propagations: propagated.length, conflict: false, conflictClause: null };
}

// ─────────────────────────── DPLL 求解器 ───────────────────────────

export interface SolveOptions {
  /** 可选种子：提供时分支启发加入 mulberry32 轻抖动（同 seed 逐位复现） */
  seed?: number;
  /**
   * R5：传播引擎（缺省 'counted'——计数文字增量维护，与 'scan' 全扫
   * 描逐位等价：同一不动点、同一 trail 序、同一学子句与全部账单）。
   * 'scan' 保留原路径作对照/审计。
   */
  engine?: 'scan' | 'counted';
  /**
   * R5：相位保存（缺省 false = 零漂移）。true 时每个变元记住最后一次
   * 指派极性，重分支先试保存相位——搜索序改变，完备性与判定不变。
   */
  phaseSaving?: boolean;
  /**
   * R5：分支启发（缺省 'mom' = 零漂移）。'vsids' 启用冲突驱动活动度
   * 分支（学子句变元 +1 活动度、0.95/冲突几何衰减；活动度全零回落 MOM）。
   */
  branching?: 'mom' | 'vsids';
}

/** 求解裁决：SAT/UNSAT + 模型 + 搜索账单（全部确定性可复现） */
export interface SolveResult {
  /** true = 存在满足指派（model 非 null）；false = 穷尽后确证不可满足 */
  sat: boolean;
  /** SAT 时的模型（全部 n 个变元；未约束变元取 true）；UNSAT 为 null */
  model: ReadonlyMap<number, boolean> | null;
  /** 分支（决策）次数 */
  decisions: number;
  /** 单位传播指派次数（含预处理） */
  propagations: number;
  /** 冲突次数（含层 0 预处理冲突） */
  conflicts: number;
  /** 学子句条数（1UIP-lite） */
  learned: number;
  /** 纯文字消去定型数（仅层 0；可满足性保持变换） */
  pureLiterals: number;
}

/**
 * DPLL 完备 SAT 求解（单位传播 → 纯文字 → MOM/VSIDS 分支 → 冲突回跳 →
 * 1UIP-lite 学子句；R5：可选相位保存 + 双传播引擎，见文件头）。
 *
 * - 预处理（层 0）：传播与纯文字交替至不动点；层 0 冲突直接 UNSAT；
 * - 搜索循环：传播（冲突则分析/学习/回跳）→ 层 0 补跑纯文字 → 分支；
 * - 完备性：分支树有限 + 回跳只剪已证无解子树 ⟹ 穷尽后 UNSAT 可靠
 *  （相位保存/VSIDS 只改搜索序，不改分支树的可穷尽性）；
 * - 确定性：无 seed 时全程确定（平局最小编号变元）；有 seed 时抖动确定；
 * - 引擎：'counted'（缺省）与 'scan' 逐位等价（同一 trail/学子句/账单）。
 */
export function dpllSolve(cnf: Cnf, options: SolveOptions = {}): SolveResult {
  validateCnf(cnf, 'dpllSolve');
  if (options === null || typeof options !== 'object') throw new Error('dpllSolve: options 需为 { seed? }');
  const seed = options.seed;
  if (seed !== undefined && !Number.isFinite(seed)) throw new Error('dpllSolve: seed 需为有限数');
  const engine = options.engine ?? 'counted';
  if (engine !== 'scan' && engine !== 'counted') {
    throw new Error(`dpllSolve: engine 需为 'scan' | 'counted'（收到 ${String(engine)}）`);
  }
  const counted = engine === 'counted';
  const phaseSaving = options.phaseSaving ?? false;
  const branching = options.branching ?? 'mom';
  if (branching !== 'mom' && branching !== 'vsids') {
    throw new Error(`dpllSolve: branching 需为 'mom' | 'vsids'（收到 ${String(branching)}）`);
  }
  const rng = seed === undefined ? null : mulberry32(seed);
  const n = cnf.numVars;

  // 子句库（原始子句 + 学子句；索引即 reason 引用）——防御性拷贝
  const db: number[][] = cnf.clauses.map((c) => [...c]);

  // 指派状态：value[v] ∈ {true, false, undefined}（下标 0 弃用）
  const value: (boolean | undefined)[] = new Array<boolean | undefined>(n + 1).fill(undefined);
  const levelOf: number[] = new Array<number>(n + 1).fill(-1);
  const reason: number[] = new Array<number>(n + 1).fill(-1);
  const trail: number[] = [];
  const trailLim: number[] = [];
  const trailPos: number[] = new Array<number>(n + 1).fill(-1);

  // ── R5 counted 引擎的子句状态（逐文字出现计数，口径 = scan 的逐
  //    文字扫描）：nUnass[i]/nTrue[i] 分别为子句 i 中未指派/为真的
  //    文字出现数；occ[v] = 含变元 v 的子句索引（按文字出现登记）──
  const nUnass: number[] = db.map((clause) => clause.filter((lit) => value[varOf(lit)] === undefined).length);
  const nTrue: number[] = db.map((clause) => clause.filter((lit) => {
    const val = value[varOf(lit)];
    return val !== undefined && val === lit > 0;
  }).length);
  const occ: Array<Array<{ idx: number; makesTrue: boolean }>> = Array.from({ length: n + 1 }, () => []);
  {
    let idx = 0;
    for (const clause of db) {
      for (const lit of clause) occ[varOf(lit)].push({ idx, makesTrue: lit > 0 });
      idx += 1;
    }
  }

  // ── R5 相位保存与 VSIDS 活动度 ──
  const savedPhase: boolean[] = new Array<boolean>(n + 1).fill(true);
  /** 是否存在真实保存相位（首次指派前不覆盖启发式自带的极性信息） */
  const hasPhase: boolean[] = new Array<boolean>(n + 1).fill(false);
  const activity: number[] = new Array<number>(n + 1).fill(0);
  let activityScale = 1; // 几何衰减分母（activity/scale 参与比较；阈值重标定防下溢）

  let decisions = 0;
  let propagations = 0;
  let conflicts = 0;
  let learnedCount = 0;
  let pureCount = 0;

  const decisionLevel = (): number => trailLim.length;

  /** counted 引擎：指派一个文字后沿出现表增量更新子句计数 */
  function countApplyAssign(v: number, val: boolean): void {
    for (const ref of occ[v]!) {
      nUnass[ref.idx] -= 1;
      if (ref.makesTrue === val) nTrue[ref.idx] += 1;
    }
  }

  /** counted 引擎：撤销指派时逆操作 */
  function countUndoAssign(v: number, val: boolean): void {
    for (const ref of occ[v]!) {
      nUnass[ref.idx] += 1;
      if (ref.makesTrue === val) nTrue[ref.idx] -= 1;
    }
  }

  function assignVar(v: number, val: boolean, reasonIdx: number): void {
    value[v] = val;
    levelOf[v] = decisionLevel();
    reason[v] = reasonIdx;
    trailPos[v] = trail.length;
    trail.push(v);
    if (counted) countApplyAssign(v, val);
  }

  /** 非时序回溯：回退到目标层（层 0 指派位于 trailLim[0] 之前，永不回退） */
  function cancelTo(target: number): void {
    while (trailLim.length > target) {
      const lim = trailLim.pop()!;
      for (let i = trail.length - 1; i >= lim; i -= 1) {
        const v = trail[i]!;
        if (phaseSaving) {
          savedPhase[v] = value[v]!; // R5：记住最后的极性
          hasPhase[v] = true;
        }
        if (counted) countUndoAssign(v, value[v]!);
        value[v] = undefined;
        levelOf[v] = -1;
        reason[v] = -1;
        trailPos[v] = -1;
      }
      trail.length = lim;
    }
  }

  /** 学子句入库（counted：登记计数与出现表） */
  function addLearned(clause: number[]): void {
    let un = 0;
    let tr = 0;
    for (const lit of clause) {
      const val = value[varOf(lit)];
      if (val === undefined) un += 1;
      else if (val === lit > 0) tr += 1;
      occ[varOf(lit)].push({ idx: db.length, makesTrue: lit > 0 });
    }
    nUnass.push(un);
    nTrue.push(tr);
    db.push(clause);
  }

  /**
   * 单位传播至不动点。返回冲突子句索引（≥0）或 -1（无冲突）。
   * 两个引擎逐位等价：scan 全扫描 vs counted O(1) 计数判定——同一
   * 「子句索引序首个单元/冲突」选择，同一 trail。
   */
  function propagate(): number {
    if (!counted) {
      for (;;) {
        let unitIdx = -1;
        let unitLit = 0;
        for (let i = 0; i < db.length; i += 1) {
          const clause = db[i]!;
          let satisfied = false;
          let count = 0;
          let unit = 0;
          for (const lit of clause) {
            const val = value[varOf(lit)];
            if (val === undefined) {
              count += 1;
              unit = lit;
              if (count > 1) break;
            } else if (val === lit > 0) {
              satisfied = true;
              break;
            }
          }
          if (satisfied) continue;
          if (count === 0) return i;
          if (count === 1 && unitIdx < 0) {
            unitIdx = i;
            unitLit = unit;
          }
        }
        if (unitIdx < 0) return -1;
        assignVar(varOf(unitLit), unitLit > 0, unitIdx);
        propagations += 1;
      }
    }
    for (;;) {
      let unitIdx = -1;
      let unitLit = 0;
      for (let i = 0; i < db.length; i += 1) {
        if (nTrue[i]! > 0) continue; // 满足子句（有真文字）
        const un = nUnass[i]!;
        if (un === 0) return i; // 全假 → 冲突
        if (un === 1 && unitIdx < 0) {
          unitIdx = i;
          for (const lit of db[i]!) {
            if (value[varOf(lit)] === undefined) {
              unitLit = lit;
              break;
            }
          }
        }
      }
      if (unitIdx < 0) return -1;
      assignVar(varOf(unitLit), unitLit > 0, unitIdx);
      propagations += 1;
    }
  }

  /**
   * 纯文字消去（只在层 0 调用——层 0 指派永久，满足子句可永久忽略）：
   * 活动子句中只出现单一极性的未指派变元按该极性定型。保持可满足性：
   * 任何满足剩余公式 的指派都可把该变元改成纯极性而不破坏任何子句。
   */
  function purePass(): number {
    const seenPos = new Set<number>();
    const seenNeg = new Set<number>();
    const candidates = new Set<number>();
    let ci = 0;
    for (const clause of db) {
      if (counted && nTrue[ci]! > 0) {
        ci += 1;
        continue;
      }
      let satisfied = false;
      const lits: number[] = [];
      for (const lit of clause) {
        const val = value[varOf(lit)];
        if (val !== undefined && val === lit > 0) {
          satisfied = true;
          break;
        }
        if (val === undefined) lits.push(lit);
      }
      ci += 1;
      if (satisfied) continue;
      for (const lit of lits) {
        const v = varOf(lit);
        candidates.add(v);
        if (lit > 0) seenPos.add(v);
        else seenNeg.add(v);
      }
    }
    let assigned = 0;
    const vs = [...candidates].sort((a, b) => a - b);
    for (const v of vs) {
      if (value[v] !== undefined) continue;
      const pos = seenPos.has(v);
      const neg = seenNeg.has(v);
      if (pos && !neg) {
        assignVar(v, true, -1);
        assigned += 1;
      } else if (!pos && neg) {
        assignVar(v, false, -1);
        assigned += 1;
      }
    }
    pureCount += assigned;
    return assigned;
  }

  /**
   * 分支文字选择。
   * · MOM（缺省）：最短活动子句中字频最大的文字；平局取最小编号变元
   *   （无 seed 时完全确定）；seed 提供时每候选加 mulberry32 × 0.5 的
   *   轻抖动（同 seed 确定）。返回 0 表示无活动子句（全部满足 → SAT）。
   * · VSIDS（R5）：冲突驱动活动度——学子句变元 +1、全体 0.95/冲突
   *   几何衰减（activityScale 阈值重标定防下溢，A3）；活动度全零回落
   *   MOM。极性：phaseSaving 开时用保存相位，否则该变元正极。
   * · phaseSaving（R5）×MOM：MOM 只定变元（按其最优字面评分），极性
   *   改用保存相位——「哪个变元」与「先试哪极」解耦（MiniSat 配置）。
   */
  function pickBranchLiteral(): number {
    let momLit = 0;
    let minLen = Number.POSITIVE_INFINITY;
    const active: number[][] = [];
    let ci = 0;
    for (const clause of db) {
      if (counted && nTrue[ci]! > 0) {
        ci += 1;
        continue;
      }
      const lits: number[] = [];
      let satisfied = false;
      for (const lit of clause) {
        const val = value[varOf(lit)];
        if (val === undefined) lits.push(lit);
        else if (val === lit > 0) {
          satisfied = true;
          break;
        }
      }
      ci += 1;
      if (satisfied) continue;
      if (lits.length === 0) {
        throw new Error('symbolic-solver: 内部不变量破坏（传播不动点后存在全假子句）');
      }
      active.push(lits);
      if (lits.length < minLen) minLen = lits.length;
    }
    if (active.length === 0) return 0;
    const freq = new Map<number, number>();
    for (const lits of active) {
      if (lits.length !== minLen) continue;
      for (const lit of lits) freq.set(lit, (freq.get(lit) ?? 0) + 1);
    }
    let bestLit = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const candidates = [...freq.keys()].sort((a, b) => varOf(a) - varOf(b));
    for (const lit of candidates) {
      const score = (freq.get(lit) ?? 0) + (rng === null ? 0 : rng() * 0.5);
      if (score > bestScore) {
        bestScore = score;
        bestLit = lit;
      }
    }
    momLit = bestLit;
    // 相位保存的极性覆盖：仅在变元确有保存相位时生效（首次指派前不
    // 覆盖启发式自带的极性信息——MOM 的字频极性本身携带信息）
    const phaseOf = (v: number, fallbackLit: number): number =>
      phaseSaving && hasPhase[v] ? (savedPhase[v]! ? v : -v) : fallbackLit;
    if (branching === 'mom') {
      if (momLit === 0) return momLit;
      return phaseOf(varOf(momLit), momLit); // MOM 变元 + 保存相位
    }
    // VSIDS：最大活动度的未指派变元（平局取最小编号——升序扫描首个
    // 严格最大即最小变元）；活动度全零 → bestVar=0 回落 MOM
    let bestVar = 0;
    let bestAct = 0;
    for (let v = 1; v <= n; v += 1) {
      if (value[v] !== undefined) continue;
      const act = activity[v]! / activityScale;
      if (act > bestAct) {
        bestAct = act;
        bestVar = v;
      }
    }
    if (bestVar === 0) {
      if (momLit === 0) return momLit;
      return phaseOf(varOf(momLit), momLit);
    }
    return phaseOf(bestVar, bestVar); // VSIDS 变元；无保存相位时正极
  }

  /** R5：VSIDS 活动度更新（学子句变元 +1；每冲突全体 0.95 倍衰减） */
  function bumpActivity(clause: number[]): void {
    activityScale *= 0.95;
    for (const lit of clause) activity[varOf(lit)] += 1;
    if (activityScale < 1e-100) {
      // A3 阈值重标定：活动度只参与比较，全体除以最大值——序不变
      let mx = 0;
      for (let v = 1; v <= n; v += 1) if (activity[v]! > mx) mx = activity[v]!;
      if (mx > 0) for (let v = 1; v <= n; v += 1) activity[v] = activity[v]! / mx;
      activityScale = 1;
    }
  }

  /**
   * 冲突分析（1UIP-lite）：从冲突子句（全假）出发，反复对本决策层中最近
   * 指派的文字与其 reason 子句做消解，直到子句中恰剩一个当前层文字（UIP）。
   * 学子句 = 消解结果（断言字 ¬UIP + 低层文字）；回跳层 = 低层文字的最大
   * 决策层（非时序：直接跳到断言层，而非逐层倒退）。
   */
  function analyze(conflictIdx: number): { learnedClause: number[]; backjumpLevel: number } {
    const dl = decisionLevel();
    let c = [...db[conflictIdx]!];
    for (;;) {
      let curCount = 0;
      let latestVar = 0;
      let latestPos = -1;
      for (const lit of c) {
        const v = varOf(lit);
        if (levelOf[v] === dl) {
          curCount += 1;
          if (trailPos[v] > latestPos) {
            latestPos = trailPos[v];
            latestVar = v;
          }
        }
      }
      if (curCount <= 1) break;
      // 本层最近指派文字必有 reason（决策变量是本层最早指派，不可能在
      // 仍剩 >1 个本层文字时成为「最近」）——否则内部不变量破坏
      const rIdx = reason[latestVar];
      if (rIdx < 0) throw new Error('symbolic-solver: 冲突分析内部不变量破坏（决策文字无 reason 却非 UIP）');
      const next: number[] = [];
      for (const lit of c) if (varOf(lit) !== latestVar && !next.includes(lit)) next.push(lit);
      for (const lit of db[rIdx]!) if (varOf(lit) !== latestVar && !next.includes(lit)) next.push(lit);
      c = next;
    }
    const learnedClause: number[] = [];
    for (const lit of c) if (!learnedClause.includes(lit)) learnedClause.push(lit);
    let backjump = 0;
    for (const lit of learnedClause) {
      const v = varOf(lit);
      if (levelOf[v] !== dl && levelOf[v] > backjump) backjump = levelOf[v];
    }
    return { learnedClause, backjumpLevel: backjump };
  }

  const result = (): SolveResult => ({
    sat: false,
    model: null,
    decisions,
    propagations,
    conflicts,
    learned: learnedCount,
    pureLiterals: pureCount,
  });

  // ── 层 0 预处理：传播与纯文字交替至不动点 ──
  for (;;) {
    const ci = propagate();
    if (ci >= 0) {
      conflicts += 1;
      return result();
    }
    if (purePass() === 0) break;
  }

  // ── 搜索主循环 ──
  for (;;) {
    const ci = propagate();
    if (ci >= 0) {
      conflicts += 1;
      if (decisionLevel() === 0) return result();
      const { learnedClause, backjumpLevel } = analyze(ci);
      if (branching === 'vsids') bumpActivity(learnedClause);
      addLearned(learnedClause);
      learnedCount += 1;
      cancelTo(backjumpLevel);
      continue; // 学子句在回跳层作为单元被下一轮传播消费（断言 ¬UIP）
    }
    if (decisionLevel() === 0 && purePass() > 0) continue; // 回跳到 0 后可能涌现新纯文字
    const branchLit = pickBranchLiteral();
    if (branchLit === 0) break; // 无活动子句：全部满足 → SAT
    trailLim.push(trail.length);
    assignVar(varOf(branchLit), branchLit > 0, -1);
    decisions += 1;
  }

  // SAT：不出现于任何活动子句的变元无约束 → 确定性补全为 true
  const model = new Map<number, boolean>();
  for (let v = 1; v <= n; v += 1) model.set(v, value[v] ?? true);
  return { sat: true, model, decisions, propagations, conflicts, learned: learnedCount, pureLiterals: pureCount };
}

// ─────────────────────────── #SAT 精确模型计数 ───────────────────────────

/** 在子句集上把文字 lit 定为真：满足子句删除、假文字剥离；dead = 剥出空子句 */
function stripAssign(clauses: readonly (readonly number[])[], lit: number): { clauses: number[][]; dead: boolean } {
  const out: number[][] = [];
  for (const clause of clauses) {
    if (clause.includes(lit)) continue;
    if (clause.includes(-lit)) {
      const stripped = clause.filter((l) => l !== -lit);
      if (stripped.length === 0) return { clauses: [], dead: true };
      out.push(stripped);
    } else {
      out.push([...clause]);
    }
  }
  return { clauses: out, dead: false };
}

/**
 * 组件分解式精确计数（递归）：
 * ① 单元传播不动点（保持计数：强制文字乘数 1）；
 * ② 子句清空 → scope 内剩余变元全自由（每个 ×2，含因满足而脱落的变元）；
 * ③ 共现图连通分量分解：#F = 2^自由 × Π_组件 #Fᵢ（互不相连变元独立）；
 * ④ 单组件分支和：#F = #F|x=T + #F|x=F（分支变元取组件内最小编号——确定）。
 * 纯文字消去对计数不保持（见文件头），计数路径禁用。
 * scope 为本子问题的全部变元；递归中 scope 严格缩小 ⟹ 有限终止。
 */
function countRecur(clauses: readonly (readonly number[])[], scope: ReadonlySet<number>): number {
  let work: number[][] = clauses.map((c) => [...c]);
  const live = new Set<number>(scope);
  for (const clause of work) if (clause.length === 0) return 0;
  // ① 单元传播不动点
  for (;;) {
    let unitLit = 0;
    for (const clause of work) {
      if (clause.length === 1) {
        unitLit = clause[0]!;
        break;
      }
    }
    if (unitLit === 0) break;
    const r = stripAssign(work, unitLit);
    if (r.dead) return 0;
    work = r.clauses;
    live.delete(varOf(unitLit));
  }
  // ② 子句清空：剩余 scope 变元全部自由
  if (work.length === 0) return 2 ** live.size;
  // ③ 共现图连通分量（union-find；按最小变元排序——确定性）
  const parentOf = new Map<number, number>();
  const occurring = new Set<number>();
  const find = (x: number): number => {
    let r = x;
    while (parentOf.get(r) !== r) r = parentOf.get(r)!;
    let cur = x;
    while (cur !== r) {
      const nx = parentOf.get(cur)!;
      parentOf.set(cur, r);
      cur = nx;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parentOf.set(ra, rb);
  };
  for (const clause of work) {
    for (const lit of clause) {
      const v = varOf(lit);
      occurring.add(v);
      if (!parentOf.has(v)) parentOf.set(v, v);
    }
    const first = varOf(clause[0]!);
    for (const lit of clause) union(first, varOf(lit));
  }
  const groups = new Map<number, Set<number>>();
  for (const v of occurring) {
    const r = find(v);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, new Set<number>([v]));
    else g.add(v);
  }
  const comps = [...groups.values()].sort((a, b) => Math.min(...a) - Math.min(...b));
  // ④ 自由变元乘数 + 各组件分支求和
  let total = 2 ** (live.size - occurring.size);
  for (const comp of comps) {
    const compClauses = work.filter((c) => c.some((lit) => comp.has(varOf(lit))));
    let branchVar = Number.POSITIVE_INFINITY;
    for (const v of comp) if (v < branchVar) branchVar = v;
    const rest = new Set<number>(comp);
    rest.delete(branchVar);
    const t = stripAssign(compClauses, branchVar);
    const f = stripAssign(compClauses, -branchVar);
    total *= (t.dead ? 0 : countRecur(t.clauses, rest)) + (f.dead ? 0 : countRecur(f.clauses, rest));
  }
  return total;
}

/**
 * #SAT 精确模型计数（sharp-SAT）：满足 CNF 的 0/1 指派总数。
 * n ≤ 20 实证可靠（锚点⑤与 2ⁿ 暴力枚举逐位一致）；护栏 n ≤ 50——计数
 * ≤ 2⁵⁰ < 2⁵³，全程 double 精确整数，无舍入误差可言。
 */
export function countModels(cnf: Cnf): number {
  validateCnf(cnf, 'countModels');
  const n = cnf.numVars;
  if (n > 50) throw new Error(`countModels: numVars=${n} 需 ≤ 50（精确整数计数护栏）`);
  for (const clause of cnf.clauses) if (clause.length === 0) return 0;
  const occurring = new Set<number>();
  for (const clause of cnf.clauses) for (const lit of clause) occurring.add(varOf(lit));
  // 不出现于任何子句的变元：每个自由 ×2
  return 2 ** (n - occurring.size) * countRecur(cnf.clauses, occurring);
}

// ─────────────────────────── 暴力对照（导出供验证） ───────────────────────────

export interface BruteForceResult {
  sat: boolean;
  /** 字典序（bitmask 升序）最小的满足指派；UNSAT 为 null */
  model: ReadonlyMap<number, boolean> | null;
}

/** 2ⁿ 全枚举暴力求解（独立于 DPLL 的对照实现；n ≤ 24 护栏） */
export function bruteForceSat(cnf: Cnf): BruteForceResult {
  validateCnf(cnf, 'bruteForceSat');
  const n = cnf.numVars;
  if (n > 24) throw new Error(`bruteForceSat: numVars=${n} 需 ≤ 24（暴力对照工具护栏）`);
  const total = 2 ** n;
  for (let mask = 0; mask < total; mask += 1) {
    let sat = true;
    for (const clause of cnf.clauses) {
      let clauseOk = false;
      for (const lit of clause) {
        const bit = (mask >> (varOf(lit) - 1)) & 1;
        if (lit > 0 ? bit === 1 : bit === 0) {
          clauseOk = true;
          break;
        }
      }
      if (!clauseOk) {
        sat = false;
        break;
      }
    }
    if (sat) {
      const model = new Map<number, boolean>();
      for (let v = 1; v <= n; v += 1) model.set(v, ((mask >> (v - 1)) & 1) === 1);
      return { sat: true, model };
    }
  }
  return { sat: false, model: null };
}

// ─────────────────────────── 随机实例工厂 ───────────────────────────

function validateKSatArgs(n: number, m: number, k: number, seed: number, who: string): void {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${who}: n=${String(n)} 需为正整数`);
  if (!Number.isInteger(m) || m < 0) throw new Error(`${who}: m=${String(m)} 需为非负整数`);
  if (!Number.isInteger(k) || k < 1 || k > n) {
    throw new Error(`${who}: k=${String(k)} 需为 [1, n] 内整数（子句内变元互异）`);
  }
  if (!Number.isFinite(seed)) throw new Error(`${who}: seed 需为有限数`);
}

/**
 * 均匀随机 k-SAT 工厂：m 个子句，每句从 1..n 局部 Fisher–Yates 抽 k 个互异
 * 变元、极性对半（mulberry32）。m/n ≈ 4.26（k=3）落在相变区——最难实例。
 */
export function randomKSat(n: number, m: number, k: number, seed: number): Cnf {
  validateKSatArgs(n, m, k, seed, 'randomKSat');
  const rng = mulberry32(seed);
  const pool = Array.from({ length: n }, (_, i) => i + 1);
  const clauses: number[][] = [];
  for (let c = 0; c < m; c += 1) {
    for (let i = 0; i < k; i += 1) {
      const j = i + Math.floor(rng() * (n - i));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    const clause: number[] = [];
    for (let i = 0; i < k; i += 1) clause.push(rng() < 0.5 ? pool[i]! : -pool[i]!);
    clauses.push(clause);
  }
  return { clauses, numVars: n };
}

/** 种植解随机 SAT 工厂：先抽隐藏指派（planted），再生成的确被其满足的子句 */
export interface PlantedInstance {
  cnf: Cnf;
  /** 种植解（满足 cnf 的全部子句——可独立代入验证） */
  planted: ReadonlyMap<number, boolean>;
}

/**
 * 种植解（planted）随机 k-SAT：变元极性对半抽成隐藏指派；每子句的每个文字
 * 若在种植解下为假则翻转极性——子句必然被满足（quiet planting）。产出
 * 保证 SAT 的相变区密度实例，供「返回模型满足全部子句」的代入验证。
 */
export function plantedSat(n: number, m: number, k: number, seed: number): PlantedInstance {
  validateKSatArgs(n, m, k, seed, 'plantedSat');
  const rng = mulberry32(seed);
  const planted = new Map<number, boolean>();
  for (let v = 1; v <= n; v += 1) planted.set(v, rng() < 0.5);
  const pool = Array.from({ length: n }, (_, i) => i + 1);
  const clauses: number[][] = [];
  for (let c = 0; c < m; c += 1) {
    for (let i = 0; i < k; i += 1) {
      const j = i + Math.floor(rng() * (n - i));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    const clause: number[] = [];
    for (let i = 0; i < k; i += 1) {
      const v = pool[i]!;
      let lit = rng() < 0.5 ? v : -v;
      if ((lit > 0) !== planted.get(v)) lit = -lit; // 种植解下为假 → 翻转
      clause.push(lit);
    }
    clauses.push(clause);
  }
  return { cnf: { clauses, numVars: n }, planted };
}

// ─────────────────────────── 模型验证工具 ───────────────────────────

/** 模型代入检查：模型覆盖全部变元且每个子句至少一个文字为真 */
export function checkModel(cnf: Cnf, model: ReadonlyMap<number, boolean>): boolean {
  validateCnf(cnf, 'checkModel');
  if (!(model instanceof Map)) throw new Error('checkModel: model 需为 Map<number, boolean>');
  for (const [v, val] of model) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`checkModel: 非法变元编号 ${String(v)}`);
    if (typeof val !== 'boolean') throw new Error(`checkModel: 变元 ${v} 的值需为 boolean`);
  }
  for (const clause of cnf.clauses) {
    let sat = false;
    for (const lit of clause) {
      const val = model.get(varOf(lit));
      if (val === undefined) throw new Error(`checkModel: 模型缺少变元 ${varOf(lit)}`);
      if (val === lit > 0) {
        sat = true;
        break;
      }
    }
    if (!sat) return false;
  }
  return true;
}

/* ── 接线建议 ──
 * 建议挂载引擎: 计划生成器（DAG 计划可行性静态裁决）、任务分派器（硬约束
 * 求解）、判断层（离散约束推理底座）。
 *   1. 计划可行性静态裁决（与 15.0 的分工——15.0 运行时验证管「执行中的
 *      时序」（LTLf 监视、事后追责），本内核管「动手前的可行性」）：
 *      DAG 计划的资源互斥（同槽任务二选一 → (¬a ∨ ¬b)）、依赖闭包
 *      （前置未选则后继不可选 → (a → b₁∨b₂) 子句化）、预算容量（至多 k
 *      个并行 → 全部 (k+1)-子集的否定子句）编码为 Cnf，dpllSolve 裁决：
 *      SAT → 计划可行（模型即一个可行资源选择）；UNSAT → 动手前判死并
 *      返回 decisions/conflicts 账单（哪个约束族最常出现在冲突里可从
 *      learned 子句统计）。countModels 可行选择总数 → 计划鲁棒性量化
 *      （唯一解 = 脆弱，多解 = 有重排余地）。
 *   2. 任务分派硬约束: 模型-任务布尔矩阵 + 互斥/容量/技能门槛子句化；
 *      UNSAT 时学子句定位最小冲突任务集（回跳到断言层的路径即冲突责任链），
 *      分派器据此降级/外包而非空转重试。
 *   3. 判断层离散推理底座: 多模型协同中的「能否同时满足 A 的格式约束、
 *      B 的预算上限、C 的工具白名单」这类合取可行性——dpllSolve 一次裁决
 *      代替逐条贪心试错；与 71.0 A* 互补（连续代价最优 vs 布尔可行性）。
 *   缺省关闭旗标名: enableSymbolicSolverKernel（缺省 false；旗标关闭时
 *      计划可行性/任务分派/判断层全部走原贪心与顺序检查路径）。
 *   挂载后改变的决策点: ① DAG 计划立项（执行前试错 → 静态裁决）；② 任务
 *      分派失败处理（盲目重试 → 学子句定位冲突集）；③ 离散约束判断（逐条
 *      门控 → 合取求解），并新增 decisions/propagations/conflicts 审计账单。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
