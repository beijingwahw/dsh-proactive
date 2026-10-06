/**
 * 86.0 分层技能内核 —— 选项框架 + 半马尔可夫决策过程：宏动作的时间信用分配
 *
 * 动机: 71.0 A* 在已知图上搜最优计划、29.0 MCTS 在未知域里采样逼近——但执行
 * 长计划时的**信用分配**仍是原步口径: 一个 DAG 计划节点是一段子程序（几十个
 * 原步动作），平坦 Q-learning 要让「这个节点值得做」的信号穿过几十步 γ^n 衰减
 * 与稀疏访问慢慢渗回去。选项框架（Sutton–Precup–Singh 1999）把「子程序」升为
 * 一等公民: 技能 ω 有名字、有入口条件 I、有终止条件 β；半马尔可夫决策过程
 * （SMDP）给整个宏动作一次时间信用——折价用 γ^k（k = 宏实际耗时），不是 γ¹。
 * 四房间（2×2 门环）与四房间走廊（房间排成线、目标 = 末门后一步的里程碑链）
 * 是两种经典构造: 前者做精确数学锚点（确定性 ⟹ 解析可断言），后者做样本
 * 效率锚点——准一维走廊上原步随机游走命中时间 O(长度²) 且价值链逐格传播全
 * 深度，而「走到门口」技能把整条走廊压缩为 3 个宏决策。
 *
 * 数学:
 *   选项三元组 ω = (I_ω ⊆ S 入口集, π_ω: S→A 内部策略, β_ω: S→[0,1] 终止函数)。
 *   执行: 在 s ∈ I_ω 启动，每步按 π_ω 动作，到达 s' 时以 β_ω(s') 概率终止。
 *   SMDP Bellman（宏展开形，k = 实际执行步数，r = 宏内折价累计回报）:
 *     Q*(s,ω) = r(s,ω) + γ^{k(s,ω)} · max_{ω'∈I(s')} Q*(s',ω'),
 *     r(s,ω) = Σ_{t<k} γ^t · r_t
 *   选项 Bellman（逐步形，intra-option 学习的不动点——与上式是**同一个** Q*）:
 *     Q*(s,ω) = r(s,π_ω(s)) + γ·[ (1−β(s'))·Q*(s',ω) + β(s')·max_{ω'∈I(s')} Q*(s',ω') ]
 *   SMDP Q-learning（Bradtke–Duff / Sutton et al.）: 宏执行 k 步后
 *     Q(s,ω) ← Q + α·[ r + γ^k·max Q(s',ω') − Q ]
 *   intra-option Q-learning（Precup–Sutton）: 每个原步 (s,a,r,s') 更新**所有**
 *     π_ω(s) = a 的选项——原步经验就能学会技能价值，无需执行宏。
 *   收敛口径: 确定性环境 + α = 1 ⟹ 每次 Q-learning 更新都是精确 Bellman 备份
 *     （Q-learning 退化为异步值迭代）⟹ 收敛到 Q* 至机器精度，残差可精确断言。
 *   折价陷阱（验证锚点④的构造）: 误用 γ¹（把宏当原子步）→ 收敛到**错误算子**
 *     的不动点，残差 = |γ^k − γ|·V(s') 量级——γ^k 不是装饰，是正确性。
 *
 * 验证锚点（scripts/verify-execution-kernels.mjs）:
 *   ① 四房间走廊（corridorGridworld: 4 房间 × 8 宽 × 5 高，27 步最优路径，目标 =
 *      末门后一步的里程碑链）: 200 种子公平对照（同种子/同 ε=0.1/同 α=1/同
 *      无上限回合/种子化随机破平）下，分层 SMDP「解题所需累计环境步数」显著
 *      少于平坦 Q-learning（加速比 ≥ 1.5 断言，实测 ~180×: ~0.3k vs ~58k 步;
 *      诚实对照: 平坦侧 200/200 种子同样解题且收敛后两者都近最优——省的是
 *      学费不是终点。边界条件已文档化: 2×2 小世界上原步扩散足够强，两者
 *      相近 ~1.2×，技能收益依赖任务-技能对齐——长计划里程碑结构正是对齐态）;
 *   ② SMDP Bellman 方程在收敛处残差 → 0（确定性环境精确断言: Q-learning ≈
 *      值迭代精确解至 1e-9; intra-option 从原步经验收敛到同一 Q*）;
 *   ③ 技能组合: 贪婪执行宏 Q 从全部 103 个非目标态到达目标（成功率 ≥ 98%，
 *      实测 100%，平均步数 = BFS 最优均值）;
 *   ④ 折价正确性: 一维走廊解析例 Q*(s₀,ω) = γ³ 而 γ¹ 误用收敛到 γ（偏差
 *      γ−γ³ = 0.092625 精确对照，且 optionBellmanResidual 对陷阱 Q 的最大
 *      残差恰等于该偏差; k=1 处两口径重合——陷阱只在宏步长 > 1 显形）。
 *
 * 确定性: 随机源仅文件内 mulberry32(seed)（起始状态 + ε 探索；配 Box–Muller
 *   gaussianNoise 供挂载侧同源高斯噪声复用）；无 I/O、无时钟、同输入同输出。
 *
 * R5-A17 世界性进化（数学轴 + 性能轴，2026-10）:
 *   ⑤ 瓶颈技能发现（Simsek–Barto 2004 的图论强化口径）:
 *     - 最短路介数（Brandes 2001, O(|V|·|E|)）: b(s) = Σ_{u≠v} σ_uv(s)/σ_uv
 *       ——门/咽喉格承载跨房最短路，介数结构性高于普通格；
 *     - 关节点（Tarjan）: 树形拓扑（走廊类）里门 = 删除后断图的点，
 *       corridorGridworld 的关节点集 == 门集（精确锚点）；
 *     - access latency（平均最短步数）作诊断副读数。
 *     optionsFromBottlenecks 从发现的瓶颈构造「走到瓶颈并停在它面前」的
 *     技能——技能库不再依赖手工标门，发现 → 构造 → SMDP 学习闭环自足。
 *   ⑥ 热路径物化: buildIndex 时把每（态,选项）的 π_ω(s)/β_ω(s) 物化为
 *     Int32/Float64 表 + intra-option 的「态×动作 → 一致选项」匹配索引；
 *     训练/冒烟的原步查询从闭包调用降为数组读，intra-option 更新从全列
 *     扫描降为只扫一致列——**与闭包逐位同值同序**（表就是构建时闭包算出的
 *     那个数；未覆盖态回退闭包，语义保真），rng 消费流不变 ⟹ 同种子同输出。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 确定性 PRNG ───────────────────────────

/** mulberry32——训练随机性（起始状态 + ε 探索）的唯一随机源（同 seed 逐位复现） */
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

/** Box–Muller 标准正态（本内核本体仅用均匀流；导出供挂载侧共享同一随机口径） */
export function gaussianNoise(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─────────────────────────── 网格世界 ───────────────────────────

/** 原步动作（上/右/下/左; const 对象 + 字面量类型，strip-types 兼容） */
export const ACTIONS = { up: 0, right: 1, down: 2, left: 3 } as const;
export type Action = 0 | 1 | 2 | 3;

/** 原步转移结果（确定性） */
export interface StepOutcome {
  /** 下一格（撞墙/出界 = 原地） */
  sNext: number;
  /** 即时回报（本内核口径: 进入目标格 +1，其余 0） */
  reward: number;
  /** 是否到达目标（回合终止） */
  done: boolean;
}

/**
 * 网格世界契约（确定性; 四房间工厂与外部自定义世界——如验证脚本的一维
 * 走廊——都满足此接口; learners 入口做全量校验后才会运行）。
 */
export interface Gridworld {
  readonly width: number;
  readonly height: number;
  /** 可走格清单（cell = y·width + x），顺序固定（行优先）——行号即 Q 的行号 */
  readonly states: readonly number[];
  /** 目标格（进入即 done，回报 +1） */
  readonly goal: number;
  /** 门格清单（四房间 = 4 个; 自定义世界可为空数组） */
  readonly doors: readonly number[];
  /**
   * 原步转移。slip=0（缺省）确定性; slip>0 时以 slip 概率动作被旋转 ±90°
   * （各 slip/2——Sutton–Precup–Singh 经典噪声动作协议），此时必须传入
   * 种子化 rng（可复现纪律）。
   */
  step(s: number, action: Action, rng?: () => number): StepOutcome;
  /** 格 → 可走邻格（确定性顺序; 用于选项内部策略构造） */
  neighbors(s: number): readonly number[];
  /** 房间编号 0..3（象限口径; 门格归其坐标所在象限，仅诊断用） */
  roomOf(s: number): 0 | 1 | 2 | 3;
  /** BFS 最短路（格间; 用于技能策略构造与最优性基准） */
  distance(s: number, target: number): number;
  /** 到目标格的 BFS 最短步数（最优性基准） */
  optimalStepsToGoal(s: number): number;
}

/** 四房间构造参数（缺省经典 11×11、目标 (10,10)、确定性） */
export interface FourRoomsConfig {
  goal?: [number, number];
  /** 动作打滑概率 ∈ [0,1)（缺省 0 = 确定性; 经典协议 1/3——选项吸收噪声的机制） */
  slip?: number;
}

/**
 * 四房间走廊世界（Sutton–Precup–Singh 经典构造）: 11×11，十字墙 x=5 / y=5，
 * 四个门 (5,1) (5,9) (1,5) (9,5) 连成环——任何房间到任何房间必须穿门。
 * 墙格 (x=5, y∉{1,9}) ∪ (y=5, x∉{1,9})，可走格 121 − 17 = 104。
 */
export function fourRoomsGridworld(config?: FourRoomsConfig): Gridworld {
  const width = 11;
  const height = 11;
  const slip = config?.slip ?? 0;
  if (!(slip >= 0 && slip < 1)) throw new Error(`fourRoomsGridworld: slip 需 ∈ [0,1)，收到 ${slip}`);
  const isWall = (x: number, y: number): boolean =>
    (x === 5 && y !== 1 && y !== 9) || (y === 5 && x !== 1 && x !== 9);
  const inside = (x: number, y: number): boolean => x >= 0 && x < width && y >= 0 && y < height;
  const walkable = (x: number, y: number): boolean => inside(x, y) && !isWall(x, y);

  const goalXy = config?.goal ?? [10, 10];
  if (!Array.isArray(goalXy) || goalXy.length !== 2) throw new Error('fourRoomsGridworld: goal 需为 [x,y]');
  const [gx, gy] = goalXy;
  if (!walkable(gx, gy) || (gx === 5 && (gy === 1 || gy === 9)) || (gy === 5 && (gx === 1 || gx === 9))) {
    throw new Error(`fourRoomsGridworld: goal (${gx},${gy}) 需为非门可走格`);
  }
  const goal = gy * width + gx;

  const states: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (walkable(x, y)) states.push(y * width + x);
    }
  }
  const stateSet = new Set(states);
  const doors = [1 * width + 5, 9 * width + 5, 5 * width + 1, 5 * width + 9];
  if (!doors.every((d) => stateSet.has(d))) throw new Error('fourRoomsGridworld: 门格构造内部错误');

  // BFS 距离缓存（按目标格惰性构建; 环形拓扑保证全连通——启动时自检）
  const distCache = new Map<number, Int32Array>();
  const distFrom = (target: number): Int32Array => {
    const hit = distCache.get(target);
    if (hit !== undefined) return hit;
    if (!stateSet.has(target)) throw new Error(`fourRoomsGridworld.distance: 未知或不可走目标 ${target}`);
    const dist = new Int32Array(width * height).fill(-1);
    dist[target] = 0;
    const queue = [target];
    for (let head = 0; head < queue.length; head += 1) {
      const cell = queue[head];
      const x = cell % width;
      const y = (cell - x) / width;
      const adj = [
        [x, y - 1],
        [x + 1, y],
        [x, y + 1],
        [x - 1, y],
      ];
      for (const [nx, ny] of adj) {
        if (!walkable(nx, ny)) continue;
        const ncell = ny * width + nx;
        if (dist[ncell] === -1) {
          dist[ncell] = dist[cell] + 1;
          queue.push(ncell);
        }
      }
    }
    distCache.set(target, dist);
    return dist;
  };
  // 自检: 全连通（所有可走格到目标有限距离）
  const goalDist = distFrom(goal);
  if (!states.every((s) => goalDist[s] >= 0)) throw new Error('fourRoomsGridworld: 内部错误——存在到不了目标的格子');

  const world: Gridworld = {
    width,
    height,
    states,
    goal,
    doors,
    step(s: number, action: Action, rng?: () => number): StepOutcome {
      if (!stateSet.has(s)) throw new Error(`step: 未知或不可走状态 ${s}`);
      if (action !== 0 && action !== 1 && action !== 2 && action !== 3) throw new Error(`step: 非法动作 ${action}`);
      let a = action;
      if (slip > 0) {
        if (typeof rng !== 'function') throw new Error('step: slip>0 的世界必须传入种子化 rng（可复现纪律）');
        if (rng() < slip) a = rng() < 0.5 ? ((action + 3) % 4) as Action : ((action + 1) % 4) as Action;
      }
      const x = s % width;
      const y = (s - x) / width;
      const nx = a === 0 ? x : a === 1 ? x + 1 : a === 2 ? x : x - 1;
      const ny = a === 0 ? y - 1 : a === 1 ? y : a === 2 ? y + 1 : y;
      const sNext = walkable(nx, ny) ? ny * width + nx : s;
      return { sNext, reward: sNext === goal ? 1 : 0, done: sNext === goal };
    },
    neighbors(s: number): readonly number[] {
      if (!stateSet.has(s)) throw new Error(`neighbors: 未知或不可走状态 ${s}`);
      const x = s % width;
      const y = (s - x) / width;
      const out: number[] = [];
      const adj: Array<[number, number, Action]> = [
        [x, y - 1, 0],
        [x + 1, y, 1],
        [x, y + 1, 2],
        [x - 1, y, 3],
      ];
      for (const [nx, ny] of adj) if (walkable(nx, ny)) out.push(ny * width + nx);
      return out;
    },
    roomOf(s: number): 0 | 1 | 2 | 3 {
      if (!stateSet.has(s)) throw new Error(`roomOf: 未知或不可走状态 ${s}`);
      const x = s % width;
      const y = (s - x) / width;
      return ((x < 5 ? 0 : 1) + (y < 5 ? 0 : 2)) as 0 | 1 | 2 | 3;
    },
    distance(s: number, target: number): number {
      if (!stateSet.has(s)) throw new Error(`distance: 未知或不可走状态 ${s}`);
      const dist = distFrom(target);
      const d = dist[s];
      if (d < 0) throw new Error(`distance: ${s} 到 ${target} 不可达（四房间应全连通）`);
      return d;
    },
    optimalStepsToGoal(s: number): number {
      return world.distance(s, goal);
    },
  };
  return world;
}

// ─────────────────────────── 四房间走廊世界 ───────────────────────────

/** 走廊构造参数（缺省: 4 房间 × 8 宽 × 5 高，目标 = 走廊尽头） */
export interface CorridorConfig {
  /** 房间数（缺省 4——「四房间走廊」） */
  rooms?: number;
  /** 每房间宽度（缺省 8; 需为正整数） */
  roomWidth?: number;
  /** 走廊高度（缺省 5; 需为奇数——门在中间行） */
  height?: number;
  /** 目标 x 坐标（缺省 = 走廊尽头 width−1） */
  goalX?: number;
  /** 动作打滑概率 ∈ [0,1)（缺省 0 = 确定性） */
  slip?: number;
}

/**
 * 四房间走廊世界: R 个房间排成一条线，房间之间以单格门相连（门在走廊中线上）。
 * 与 2×2 四房间同构的「门 = 里程碑」结构，但拓扑是准一维走廊——原步随机游走
 * 的命中时间随走廊长度**二次**增长、价值链必须逐格传播全深度; 而「走到门口」
 * 技能把整条走廊压缩为 R−1 个宏决策——时间抽象的样本效率优势在这里结构性
 * 显现（验证锚点①的实验场; 精确数学锚点②③④在 2×2 四房间上做）。
 */
export function corridorGridworld(config?: CorridorConfig): Gridworld {
  const rooms = config?.rooms ?? 4;
  const roomWidth = config?.roomWidth ?? 8;
  const height = config?.height ?? 5;
  const slip = config?.slip ?? 0;
  if (!Number.isInteger(rooms) || rooms < 2) throw new Error(`corridorGridworld: rooms 需为 ≥2 的整数，收到 ${rooms}`);
  if (!Number.isInteger(roomWidth) || roomWidth < 1) throw new Error(`corridorGridworld: roomWidth 需为正整数，收到 ${roomWidth}`);
  if (!Number.isInteger(height) || height < 3 || height % 2 !== 1) throw new Error(`corridorGridworld: height 需为 ≥3 的奇数，收到 ${height}`);
  if (!(slip >= 0 && slip < 1)) throw new Error(`corridorGridworld: slip 需 ∈ [0,1)，收到 ${slip}`);
  const width = rooms * roomWidth + (rooms - 1);
  const midY = (height - 1) / 2;
  const doorCols: number[] = [];
  for (let k = 0; k < rooms - 1; k += 1) doorCols.push(k * (roomWidth + 1) + roomWidth);
  const isWall = (x: number, y: number): boolean => doorCols.includes(x) && y !== midY;
  const inside = (x: number, y: number): boolean => x >= 0 && x < width && y >= 0 && y < height;
  const walkable = (x: number, y: number): boolean => inside(x, y) && !isWall(x, y);
  const goalX = config?.goalX ?? width - 1;
  if (!Number.isInteger(goalX) || goalX < 0 || goalX >= width || !walkable(goalX, midY) || doorCols.includes(goalX)) {
    throw new Error(`corridorGridworld: goalX=${String(goalX)} 需为非门可走列（走廊中线行）`);
  }
  const goal = midY * width + goalX;
  const states: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (walkable(x, y)) states.push(y * width + x);
  }
  const stateSet = new Set(states);
  const doors = doorCols.map((x) => midY * width + x);
  const distCache = new Map<number, Int32Array>();
  const distFrom = (target: number): Int32Array => {
    const hit = distCache.get(target);
    if (hit !== undefined) return hit;
    if (!stateSet.has(target)) throw new Error(`corridorGridworld.distance: 未知或不可走目标 ${target}`);
    const dist = new Int32Array(width * height).fill(-1);
    dist[target] = 0;
    const queue = [target];
    for (let head = 0; head < queue.length; head += 1) {
      const cell = queue[head];
      const x = cell % width;
      const y = (cell - x) / width;
      const adj = [
        [x, y - 1],
        [x + 1, y],
        [x, y + 1],
        [x - 1, y],
      ];
      for (const [nx, ny] of adj) {
        if (!walkable(nx, ny)) continue;
        const ncell = ny * width + nx;
        if (dist[ncell] === -1) {
          dist[ncell] = dist[cell] + 1;
          queue.push(ncell);
        }
      }
    }
    distCache.set(target, dist);
    return dist;
  };
  const goalDist = distFrom(goal);
  if (!states.every((s) => goalDist[s] >= 0)) throw new Error('corridorGridworld: 内部错误——存在到不了目标的格子');
  const roomOfX = (x: number): 0 | 1 | 2 | 3 => {
    let r = 0;
    for (const dc of doorCols) {
      if (x > dc) r += 1;
    }
    return Math.min(rooms - 1, r) as 0 | 1 | 2 | 3;
  };
  const world: Gridworld = {
    width,
    height,
    states,
    goal,
    doors,
    step(s: number, action: Action, rng?: () => number): StepOutcome {
      if (!stateSet.has(s)) throw new Error(`corridor.step: 未知或不可走状态 ${s}`);
      if (action !== 0 && action !== 1 && action !== 2 && action !== 3) throw new Error(`corridor.step: 非法动作 ${action}`);
      let a = action;
      if (slip > 0) {
        if (typeof rng !== 'function') throw new Error('corridor.step: slip>0 的世界必须传入种子化 rng（可复现纪律）');
        if (rng() < slip) a = rng() < 0.5 ? ((action + 3) % 4) as Action : ((action + 1) % 4) as Action;
      }
      const x = s % width;
      const y = (s - x) / width;
      const nx = a === 0 ? x : a === 1 ? x + 1 : a === 2 ? x : x - 1;
      const ny = a === 0 ? y - 1 : a === 1 ? y : a === 2 ? y + 1 : y;
      const sNext = walkable(nx, ny) ? ny * width + nx : s;
      return { sNext, reward: sNext === goal ? 1 : 0, done: sNext === goal };
    },
    neighbors(s: number): readonly number[] {
      if (!stateSet.has(s)) throw new Error(`corridor.neighbors: 未知或不可走状态 ${s}`);
      const x = s % width;
      const y = (s - x) / width;
      const out: number[] = [];
      const adj: Array<[number, number]> = [
        [x, y - 1],
        [x + 1, y],
        [x, y + 1],
        [x - 1, y],
      ];
      for (const [nx, ny] of adj) if (walkable(nx, ny)) out.push(ny * width + nx);
      return out;
    },
    roomOf(s: number): 0 | 1 | 2 | 3 {
      if (!stateSet.has(s)) throw new Error(`corridor.roomOf: 未知或不可走状态 ${s}`);
      return roomOfX(s % width);
    },
    distance(s: number, target: number): number {
      if (!stateSet.has(s)) throw new Error(`corridor.distance: 未知或不可走状态 ${s}`);
      const d = distFrom(target)[s];
      if (d < 0) throw new Error(`corridor.distance: ${s} 到 ${target} 不可达`);
      return d;
    },
    optimalStepsToGoal(s: number): number {
      return world.distance(s, goal);
    },
  };
  return world;
}

// ─────────────────────────── 选项（技能） ───────────────────────────

export type OptionKind = 'hallway' | 'primitive';

/** 选项 ω = (I 入口集, π 内部策略, β 终止函数)——技能的一等公民表示 */
export interface Option {
  readonly id: string;
  readonly kind: OptionKind;
  readonly description: string;
  /** 入口集 I_ω ⊆ S（不可启动的态返回 false） */
  readonly initiation: (s: number) => boolean;
  /** 内部策略 π_ω（在 I_ω 内每步的原步动作; 须确定性保证可复现） */
  readonly policy: (s: number) => Action;
  /** 终止函数 β_ω ∈ [0,1]（本内核用 0/1 硬终止; ≥1 视为必停） */
  readonly beta: (s: number) => number;
}

/** 四个原步动作作为单步选项（SMDP 经典做法: 技能 + 原步混用，保证目标可达） */
export function primitiveOptions(world: Gridworld): Option[] {
  const names = ['up', 'right', 'down', 'left'] as const;
  return [0, 1, 2, 3].map((a) => ({
    id: `primitive-${names[a]}`,
    kind: 'primitive' as const,
    description: `原步动作 ${names[a]}（单步选项，k=1）`,
    initiation: (s: number): boolean => s !== world.goal,
    policy: (): Action => a as Action,
    beta: (): number => 1,
  }));
}

/** 走廊技能构造配置 */
export interface HallwayOptionsConfig {
  /**
   * true = 入口集限制在门连通的两个房间（技能语义「本房间走到门」——
   * 宏探索不会被跨图长宏拽走）; 缺省 false = 除门/目标外全域可启动。
   * 门的邻房由 door 的可走邻居所在房间自动推断（2×2 四房间与走廊通用）。
   */
  restrictToAdjacentRooms?: boolean;
}

/**
 * 走廊技能: 每个门一个选项 ω_D =「沿 BFS 最短路走到 D 并停在门口」。
 * 内部策略 = 贪婪沿 distance(·, D) 递减方向（动作序 up>right>down>left 破平，
 * 确定性，全域有定义——打滑漂移安全）; 终止 β(D)=1。
 * 策略在构造时一次性物化为查表（SMDP 训练每步都调它——热路径零分配）。
 */
export function hallwayOptions(world: Gridworld, config?: HallwayOptionsConfig): Option[] {
  const restrict = config?.restrictToAdjacentRooms ?? false;
  return world.doors.map((door, i) => {
    const x = door % world.width;
    const y = (door - x) / world.width;
    let allowedRooms: Set<number> | null = null;
    if (restrict) {
      allowedRooms = new Set(world.neighbors(door).map((n) => world.roomOf(n)));
    }
    const table = new Map<number, Action>();
    for (const s of world.states) {
      if (s === door || s === world.goal) continue;
      if (allowedRooms !== null && !allowedRooms.has(world.roomOf(s))) continue;
      const d = world.distance(s, door);
      if (!(d > 0)) continue;
      let chosen: Action | undefined;
      for (const a of [0, 1, 2, 3] as Action[]) {
        const delta = a === 0 ? -world.width : a === 1 ? 1 : a === 2 ? world.width : -1;
        const ncell = s + delta;
        if (world.neighbors(s).includes(ncell) && world.distance(ncell, door) === d - 1) {
          chosen = a;
          break;
        }
      }
      if (chosen === undefined) throw new Error('hallwayOptions: BFS 内部一致性破坏（找不到距离递减邻居）');
      table.set(s, chosen);
    }
    return {
      id: `hallway-to-door-${i + 1}@(${x},${y})`,
      kind: 'hallway' as const,
      description: `技能: 导航到门 ${i + 1} (${x},${y}) 并停在门口（BFS 最短路内部策略）`,
      initiation: (s: number): boolean => s !== door && s !== world.goal && (allowedRooms === null || allowedRooms.has(world.roomOf(s))),
      policy: (s: number): Action => {
        const a = table.get(s);
        if (a === undefined) throw new Error(`hallwayOptions.policy: 状态 ${s} 不在策略表覆盖范围（构造表未覆盖）`);
        return a;
      },
      beta: (s: number): number => (s === door ? 1 : 0),
    };
  });
}

// ─────────────────────────── R5: 瓶颈技能发现（介数 / 关节点 / 存取延迟） ───────────────────────────

/** 瓶颈诊断: 一个状态的三个「咽喉度」读数 */
export interface BottleneckInfo {
  /** 格号 */
  state: number;
  /** 最短路介数（有序对口径；无向图 = 2× 标准无向介数——排序不变） */
  betweenness: number;
  /** 是否关节点（删除后图断开——树形拓扑里门的结构特征） */
  isArticulation: boolean;
  /** access latency: 到其余格的平均 BFS 步数（Simsek–Barto，越低越居中） */
  accessLatency: number;
}

/** 图结构辅助: 行号索引 + 邻接表（world.neighbors 的确定性快照） */
function graphOf(world: Gridworld): { rowIndex: Map<number, number>; adj: number[][] } {
  const rowIndex = new Map<number, number>();
  world.states.forEach((s, i) => rowIndex.set(s, i));
  const adj = world.states.map((s) => {
    const ns = world.neighbors(s).map((n2) => {
      const r = rowIndex.get(n2);
      if (r === undefined) throw new Error(`graphOf: neighbors(${s}) 返回未知格 ${n2}`);
      return r;
    });
    return ns;
  });
  return { rowIndex, adj };
}

/**
 * 最短路介数（Brandes 2001，无权图，O(|V|·|E|)，确定性）:
 * b(s) = Σ_{u≠v≠s} σ_uv(s)/σ_uv（σ = 最短路条数）。门/咽喉格承载全部
 * 跨房路径 ⟹ 介数结构性高于房内格——「哪些格子值得设技能」第一次有了
 * 与世界无关的纯图论读数。
 */
export function stateBetweenness(world: Gridworld): number[] {
  const n = world.states.length;
  const { adj } = graphOf(world);
  const betweenness = new Array<number>(n).fill(0);
  for (let src = 0; src < n; src += 1) {
    const sigma = new Array<number>(n).fill(0);
    const dist = new Array<number>(n).fill(-1);
    sigma[src] = 1;
    dist[src] = 0;
    const queue: number[] = [src];
    const order: number[] = [];
    for (let h = 0; h < queue.length; h += 1) {
      const v = queue[h]!;
      order.push(v);
      for (const w of adj[v]!) {
        if (dist[w] === -1) {
          dist[w] = dist[v]! + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v]! + 1) sigma[w]! += sigma[v]!;
      }
    }
    // 依赖逆序累积: δ(v) = Σ_{w: dist[w]=dist[v]+1} (σ_v/σ_w)·(1 + δ(w))
    const delta = new Array<number>(n).fill(0);
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const v = order[i]!;
      for (const w of adj[v]!) {
        if (dist[w] === dist[v]! + 1 && sigma[w]! > 0) {
          delta[v]! += (sigma[v]! / sigma[w]!) * (1 + delta[w]!);
        }
      }
      if (v !== src) betweenness[v]! += delta[v]!;
    }
  }
  return betweenness;
}

/** 关节点（迭代 Tarjan；返回行号升序）——删除后图断开的点（门的树形特征） */
export function articulationPoints(world: Gridworld): number[] {
  const n = world.states.length;
  const { adj } = graphOf(world);
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const isArt = new Uint8Array(n);
  let timer = 0;
  for (let start = 0; start < n; start += 1) {
    if (disc[start] !== -1) continue;
    let rootChildren = 0;
    disc[start] = timer;
    low[start] = timer;
    timer += 1;
    const stack: Array<{ v: number; iter: number }> = [{ v: start, iter: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const neighbors = adj[top.v]!;
      if (top.iter < neighbors.length) {
        const w = neighbors[top.iter]!;
        top.iter += 1;
        if (disc[w] === -1) {
          parent[w] = top.v;
          disc[w] = timer;
          low[w] = timer;
          timer += 1;
          stack.push({ v: w, iter: 0 });
          if (top.v === start) rootChildren += 1;
        } else if (w !== parent[top.v]) {
          low[top.v] = Math.min(low[top.v], disc[w]);
        }
      } else {
        stack.pop();
        if (stack.length > 0) {
          const p = stack[stack.length - 1]!;
          low[p.v] = Math.min(low[p.v], low[top.v]);
          if (parent[top.v] === p.v && p.v !== start && low[top.v] >= disc[p.v]) isArt[p.v] = 1;
        }
      }
    }
    if (rootChildren >= 2) isArt[start] = 1;
  }
  const out: number[] = [];
  for (let v = 0; v < n; v += 1) if (isArt[v] === 1) out.push(v);
  return out;
}

/**
 * 瓶颈状态发现: 介数降序（平局取小行号）的全景排名 + 关节点/存取延迟标注。
 * count 缺省 = 关节点数（无关节点时 ⌈√|S|⌉——网格世界无墙时无瓶颈，
 * 用介数顶部做温和兜底）。
 */
export function bottleneckStates(world: Gridworld, options?: { count?: number }): BottleneckInfo[] {
  const n = world.states.length;
  const betweenness = stateBetweenness(world);
  const artSet = new Set(articulationPoints(world));
  // access latency: 逐状态一次 BFS 取平均距离
  const { adj } = graphOf(world);
  const latency = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s += 1) {
    const dist = new Int32Array(n).fill(-1);
    dist[s] = 0;
    const queue = [s];
    let sum = 0;
    let reached = 0;
    for (let h = 0; h < queue.length; h += 1) {
      const v = queue[h]!;
      for (const w of adj[v]!) {
        if (dist[w] !== -1) continue;
        dist[w] = dist[v] + 1;
        sum += dist[w];
        reached += 1;
        queue.push(w);
      }
    }
    latency[s] = reached > 0 ? sum / reached : 0;
  }
  const ranked = Array.from({ length: n }, (_, r) => r).sort((a, b) => {
    if (betweenness[b]! !== betweenness[a]!) return betweenness[b]! - betweenness[a]!;
    return a - b;
  });
  const count = options?.count ?? (artSet.size > 0 ? artSet.size : Math.max(1, Math.ceil(Math.sqrt(n))));
  if (!Number.isInteger(count) || count < 1) throw new Error(`bottleneckStates: count 需为正整数（收到 ${String(options?.count)}）`);
  const capped = Math.min(count, n);
  return ranked.slice(0, capped).map((r) => ({
    state: world.states[r]!,
    betweenness: betweenness[r]!,
    isArticulation: artSet.has(r),
    accessLatency: latency[r]!,
  }));
}

/**
 * 从瓶颈构造技能: 每个瓶颈 b 一个选项 ω_b =「沿 BFS 最短路走到 b 并停在它
 * 面前」（内部策略 = 距离递减方向，终止 β(b)=1，全域可启动除 b/goal 自身）。
 * 与 hallwayOptions 同构——但目标格来自**发现**而非手工标注。
 */
export function optionsFromBottlenecks(world: Gridworld, bottlenecks: ReadonlyArray<BottleneckInfo>): Option[] {
  if (!Array.isArray(bottlenecks) || bottlenecks.length === 0) {
    throw new Error('optionsFromBottlenecks: bottlenecks 需为非空数组');
  }
  for (const b of bottlenecks) {
    if (!b || typeof b !== 'object' || !world.states.includes(b.state)) {
      throw new Error(`optionsFromBottlenecks: 未知瓶颈格 ${String(b?.state)}`);
    }
  }
  return bottlenecks.map((b, i) => {
    const x = b.state % world.width;
    const y = (b.state - x) / world.width;
    const table = new Map<number, Action>();
    for (const s of world.states) {
      if (s === b.state || s === world.goal) continue;
      const d = world.distance(s, b.state);
      if (!(d > 0)) continue;
      let chosen: Action | undefined;
      for (const a of [0, 1, 2, 3] as Action[]) {
        const delta = a === 0 ? -world.width : a === 1 ? 1 : a === 2 ? world.width : -1;
        const ncell = s + delta;
        if (world.neighbors(s).includes(ncell) && world.distance(ncell, b.state) === d - 1) {
          chosen = a;
          break;
        }
      }
      if (chosen === undefined) throw new Error('optionsFromBottlenecks: BFS 内部一致性破坏（找不到距离递减邻居）');
      table.set(s, chosen);
    }
    return {
      id: `bottleneck-${i + 1}@(${x},${y})`,
      kind: 'hallway' as const,
      description: `发现技能: 导航到瓶颈 ${i + 1} (${x},${y}) 并停在它面前（介数 ${b.betweenness.toFixed(0)}${b.isArticulation ? '，关节点' : ''}）`,
      initiation: (s: number): boolean => s !== b.state && s !== world.goal,
      policy: (s: number): Action => {
        const a = table.get(s);
        if (a === undefined) throw new Error(`optionsFromBottlenecks.policy: 状态 ${s} 不在策略表覆盖范围`);
        return a;
      },
      beta: (s: number): number => (s === b.state ? 1 : 0),
    };
  });
}

// ─────────────────────────── R5: 物化表探针（挂载侧/验证侧共用） ───────────────────────────

/** 物化表只读探针: 与闭包逐位同值的快速策略/终止/匹配查询 */
export interface OptionTableProbe {
  /** π_ω(s)（可启动态 = 表读；未覆盖态回退闭包——与旧路径同语义） */
  policyAt(s: number, col: number): Action;
  /** β_ω(s)（同上双层） */
  betaAt(s: number, col: number): number;
  /** 在 s 可启动且 π_ω(s) = action 的选项列（升序） */
  matchAt(s: number, action: Action): readonly number[];
}

/** 构建一次索引，返回物化表探针（学习器热路径使用的同一套查询） */
export function optionTables(world: Gridworld, options: Option[]): OptionTableProbe {
  const index = buildIndex(world, options);
  return {
    policyAt: (s: number, col: number): Action => {
      const row = index.rowIndex.get(s);
      if (row === undefined || col < 0 || col >= index.cols) throw new Error(`optionTables.policyAt: 非法 (s=${s}, col=${col})`);
      return policyAt(index, world, options, row, col);
    },
    betaAt: (s: number, col: number): number => {
      const row = index.rowIndex.get(s);
      if (row === undefined || col < 0 || col >= index.cols) throw new Error(`optionTables.betaAt: 非法 (s=${s}, col=${col})`);
      return betaAt(index, world, options, row, col);
    },
    matchAt: (s: number, action: Action): readonly number[] => {
      const row = index.rowIndex.get(s);
      if (row === undefined) throw new Error(`optionTables.matchAt: 未知状态 ${s}`);
      return index.matchAvail[row]![action]!;
    },
  };
}

// ─────────────────────────── 公共校验与索引 ───────────────────────────

interface WorldIndex {
  rows: number;
  cols: number;
  rowIndex: Map<number, number>;
  nonGoal: number[];
  /** avail[row][col] = 选项 col 在该态是否可启动（s ≠ goal 且 initiation） */
  avail: boolean[][];
  /** availList[row] = 可启动选项列号清单（ε-贪婪热路径零分配） */
  availList: number[][];
  /**
   * R5 热路径物化: policyTable[row·cols+col] = π_ω(s)（−1 = 未物化=不可启动，
   * 回退闭包求值）；betaTable 同构。训练每步的原步策略/终止查询从闭包调用
   * 降为数组读——与闭包逐位同值（buildIndex 构建时用同一闭包算出）。
   */
  policyTable: Int32Array;
  betaTable: Float64Array;
  /** matchAvail[row][a] = 可启动且 π_ω(s) = a 的选项列号（升序）——
   *  intra-option 更新的「每步全列扫描」变「每步只扫一致选项」 */
  matchAvail: number[][][];
}

/** 世界契约全量校验（状态集/转移/邻接/距离）+ 选项校验（id/策略域/入口覆盖） */
function buildIndex(world: Gridworld, options: Option[]): WorldIndex {
  if (!world || !Array.isArray(world.states) || world.states.length === 0) throw new Error('buildIndex: world.states 需为非空数组');
  if (typeof world.width !== 'number' || typeof world.height !== 'number' || !(world.width > 0) || !(world.height > 0)) {
    throw new Error('buildIndex: width/height 需为正数');
  }
  const rowIndex = new Map<number, number>();
  world.states.forEach((s, i) => {
    if (!Number.isInteger(s) || s < 0 || s >= world.width * world.height) throw new Error(`buildIndex: 非法状态 ${s}`);
    if (rowIndex.has(s)) throw new Error(`buildIndex: 状态 ${s} 重复`);
    rowIndex.set(s, i);
  });
  if (!rowIndex.has(world.goal)) throw new Error('buildIndex: goal 必须在 states 中');
  // 转移/邻接/距离契约抽样全检（确定性世界 → 全检即穷举，S×4 次）
  const probeRng = mulberry32(0); // 校验探针专用（slip 世界合法转移仍须成立; 不触碰训练随机流）
  for (const s of world.states) {
    for (const a of [0, 1, 2, 3] as Action[]) {
      const out = world.step(s, a, probeRng);
      if (!out || !rowIndex.has(out.sNext)) throw new Error(`buildIndex: step(${s},${a}) 返回未知 sNext`);
      if (typeof out.reward !== 'number' || !Number.isFinite(out.reward)) throw new Error(`buildIndex: step(${s},${a}) 回报需为有限数`);
      if (typeof out.done !== 'boolean') throw new Error(`buildIndex: step(${s},${a}) done 需为布尔`);
    }
    for (const n of world.neighbors(s)) if (!rowIndex.has(n)) throw new Error(`buildIndex: neighbors(${s}) 含未知格 ${n}`);
    if (!Number.isFinite(world.optimalStepsToGoal(s)) || world.optimalStepsToGoal(s) < 0) {
      throw new Error(`buildIndex: optimalStepsToGoal(${s}) 需为有限非负数`);
    }
  }
  if (!Array.isArray(options) || options.length === 0) throw new Error('buildIndex: options 需为非空数组');
  const ids = new Set<string>();
  for (const opt of options) {
    if (!opt || typeof opt.id !== 'string' || opt.id.length === 0) throw new Error('buildIndex: 选项缺少 id');
    if (ids.has(opt.id)) throw new Error(`buildIndex: 选项 id "${opt.id}" 重复`);
    ids.add(opt.id);
    if (typeof opt.initiation !== 'function' || typeof opt.policy !== 'function' || typeof opt.beta !== 'function') {
      throw new Error(`buildIndex: 选项 "${opt.id}" 需实现 initiation/policy/beta`);
    }
  }
  const rows = world.states.length;
  const cols = options.length;
  const avail: boolean[][] = [];
  const policyTable = new Int32Array(rows * cols).fill(-1);
  const betaTable = new Float64Array(rows * cols).fill(-1);
  for (let r = 0; r < rows; r += 1) {
    const s = world.states[r];
    const rowAvail: boolean[] = new Array(cols).fill(false);
    for (let c = 0; c < cols; c += 1) {
      const opt = options[c];
      const on = s !== world.goal && opt.initiation(s);
      rowAvail[c] = on;
      if (on) {
        const a = opt.policy(s);
        if (a !== 0 && a !== 1 && a !== 2 && a !== 3) throw new Error(`buildIndex: 选项 "${opt.id}" policy(${s}) 返回非法动作 ${a}`);
        const beta = opt.beta(s);
        if (typeof beta !== 'number' || !Number.isFinite(beta) || beta < 0 || beta > 1) {
          throw new Error(`buildIndex: 选项 "${opt.id}" beta(${s}) 需 ∈ [0,1]`);
        }
        policyTable[r * cols + c] = a;
        betaTable[r * cols + c] = beta;
      }
    }
    avail.push(rowAvail);
  }
  // 覆盖性: 每个非目标态至少一个可启动选项（否则该态无决策可用）
  const availList: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const list: number[] = [];
    for (let c = 0; c < cols; c += 1) if (avail[r][c]) list.push(c);
    availList.push(list);
    if (world.states[r] !== world.goal && list.length === 0) {
      throw new Error(`buildIndex: 状态 ${world.states[r]} 无任何可启动选项（不可达决策点）`);
    }
  }
  // intra-option 匹配索引: matchAvail[row][a]（升序——与旧「全列扫描 + 过滤」同序）
  const matchAvail: number[][][] = [];
  for (let r = 0; r < rows; r += 1) {
    const byAction: number[][] = [[], [], [], []];
    for (let c = 0; c < cols; c += 1) {
      const a = policyTable[r * cols + c];
      if (a >= 0) byAction[a]!.push(c);
    }
    matchAvail.push(byAction);
  }
  const nonGoal = world.states.filter((s) => s !== world.goal);
  return { rows, cols, rowIndex, nonGoal, avail, availList, policyTable, betaTable, matchAvail };
}

/** 物化策略读: 表命中（可启动态）直接读，否则回退闭包（语义与旧路径逐位同） */
function policyAt(index: WorldIndex, world: Gridworld, options: Option[], row: number, col: number): Action {
  const t = index.policyTable[row * index.cols + col];
  if (t >= 0) return t as Action;
  return options[col]!.policy(world.states[row]!);
}

/** 物化终止函数读: 同 policyAt 的表/闭包双层 */
function betaAt(index: WorldIndex, world: Gridworld, options: Option[], row: number, col: number): number {
  const t = index.betaTable[row * index.cols + col];
  if (t >= 0) return t;
  return options[col]!.beta(world.states[row]!);
}

/**
 * ε-贪婪选列（可用列内）。破平口径:
 *   'lowest'（缺省）—— 平局取最小列号: 冒烟/贪婪执行的确定性保证;
 *   'random' —— 种子化随机破平: 训练期的标准做法（消除「平局锁定」——
 *   零初始化下确定性破平会把行为策略锁死在固定环/固定墙上，探索失效）。
 */
type TieBreak = 'lowest' | 'random';
function pickOption(availCols: number[], Qrow: number[], epsilon: number, rng: () => number, tieBreak: TieBreak): number {
  if (availCols.length === 0) throw new Error('pickOption: 无可用选项（buildIndex 已保证覆盖，内部错误）');
  if (rng() < epsilon) return availCols[Math.floor(rng() * availCols.length) % availCols.length];
  let maxValue = Qrow[availCols[0]];
  for (let i = 1; i < availCols.length; i += 1) {
    if (Qrow[availCols[i]] > maxValue) maxValue = Qrow[availCols[i]];
  }
  if (tieBreak === 'random') {
    const argmax: number[] = [];
    for (let i = 0; i < availCols.length; i += 1) {
      if (Qrow[availCols[i]] === maxValue) argmax.push(availCols[i]);
    }
    return argmax[Math.floor(rng() * argmax.length) % argmax.length];
  }
  for (let i = 0; i < availCols.length; i += 1) {
    if (Qrow[availCols[i]] === maxValue) return availCols[i];
  }
  return availCols[0];
}

/** 可用列上的最大 Q（目标行无可用列 → 0; 调用方保证非目标态） */
function maxAvailQ(availRow: boolean[], Qrow: number[]): number {
  let best = -Infinity;
  for (let c = 0; c < availRow.length; c += 1) {
    if (availRow[c] && Qrow[c] > best) best = Qrow[c];
  }
  return best === -Infinity ? 0 : best;
}

// ─────────────────────────── SMDP Q-learning（宏动作层） ───────────────────────────

export interface SmdpQLearningConfig {
  world: Gridworld;
  options: Option[];
  episodes: number;
  /** RNG 种子（缺省 1） */
  seed?: number;
  /** 折扣 γ ∈ (0,1)（缺省 0.95） */
  gamma?: number;
  /** 探索率 ε ∈ [0,1]（缺省 0.15; 与 flatQLearning 同口径保证公平对照） */
  epsilon?: number;
  /** 学习率 α ∈ (0,1]（缺省 1——确定性环境下 = 精确 Bellman 备份，可精确断言） */
  alpha?: number;
  /** 每回合环境步数上限（缺省 8·(width+height)） */
  maxStepsPerEpisode?: number;
  /**
   * 折价指数口径: 'duration'（正确，γ^k，k = 宏实际耗时）| 'unit'（陷阱演示:
   * 误用 γ¹ 且宏内回报不折价——把宏当原子步; 收敛到错误算子的不动点，
   * 供验证锚点④量化展示，生产禁用）
   */
  discountExponentMode?: 'duration' | 'unit';
  /** Q 初值（缺省 0; 乐观初始化可加速探索且不破坏 α=1 精确收敛口径） */
  initialQ?: number;
  /** 固定起始格（Sutton–Precup–Singh 经典协议 = 固定起点; 缺省 = 每回合随机非目标起态） */
  startCell?: number;
  /** 贪婪平局破法: 'lowest'（缺省，确定性）| 'random'（种子化——训练推荐，消除平局锁定） */
  tieBreak?: 'lowest' | 'random';
}

export interface LearnerResult {
  /** Q[行=states 序][列=options 序]（flat 为 4 原步动作列） */
  Q: number[][];
  /** 每回合消耗的环境步数（宏动作按实际原步计数——样本效率的公平口径） */
  stepsPerEpisode: number[];
  /** 每回合未折价回报 */
  returnsPerEpisode: number[];
  meta: {
    kind: 'smdp' | 'flat' | 'intra-option';
    episodes: number;
    gamma: number;
    epsilon: number;
    alpha: number;
    discountExponentMode?: 'duration' | 'unit';
    totalSteps: number;
  };
}

/** 数值配置公共校验 */
function validateCommon(gamma: number, epsilon: number, alpha: number, episodes: number, cap: number, seed: number): void {
  if (!(gamma > 0 && gamma < 1)) throw new Error(`gamma 需 ∈ (0,1)，收到 ${gamma}`);
  if (!(epsilon >= 0 && epsilon <= 1)) throw new Error(`epsilon 需 ∈ [0,1]，收到 ${epsilon}`);
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`alpha 需 ∈ (0,1]，收到 ${alpha}`);
  if (!Number.isInteger(episodes) || episodes < 1) throw new Error(`episodes 需为正整数，收到 ${episodes}`);
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`maxStepsPerEpisode 需为正整数，收到 ${cap}`);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`seed 需为非负整数，收到 ${seed}`);
}

/** 回合起始态: 固定起点协议（Sutton 原始协议）或种子化随机非目标起态 */
function pickStartCell(nonGoal: number[], startCell: number | undefined, who: string, rng: () => number): number {
  if (startCell === undefined) return nonGoal[Math.floor(rng() * nonGoal.length) % nonGoal.length];
  if (!nonGoal.includes(startCell)) throw new Error(`${who}: startCell ${startCell} 须为非目标可走格`);
  rng(); // 消耗一次随机数保持两种口径的随机流形状一致（可复现性口径统一）
  return startCell;
}

/**
 * SMDP Q-learning: 在选项层决策，宏执行 k 步后一次性更新
 *   Q(s,ω) ← Q + α·[ r + γ^k·max Q(s',ω') − Q ]（r = 宏内折价累计回报）。
 * 折价指数用**实测**宏步长 k（回合预算截断的宏按截断步数计——诚实口径）。
 */
export function smdpQLearning(config: SmdpQLearningConfig): LearnerResult {
  if (!config) throw new Error('smdpQLearning: 缺少配置');
  const world = config.world;
  const options = config.options;
  const gamma = config.gamma ?? 0.95;
  const epsilon = config.epsilon ?? 0.15;
  const alpha = config.alpha ?? 1;
  const episodes = config.episodes;
  const seed = config.seed ?? 1;
  const cap = config.maxStepsPerEpisode ?? 8 * (world.width + world.height);
  const mode = config.discountExponentMode ?? 'duration';
  const initialQ = config.initialQ ?? 0;
  const tieBreak = config.tieBreak ?? 'lowest';
  if (tieBreak !== 'lowest' && tieBreak !== 'random') throw new Error(`tieBreak 需为 'lowest'|'random'，收到 ${String(tieBreak)}`);
  if (mode !== 'duration' && mode !== 'unit') throw new Error(`discountExponentMode 需为 'duration'|'unit'，收到 ${String(mode)}`);
  validateCommon(gamma, epsilon, alpha, episodes, cap, seed);
  if (!Number.isFinite(initialQ)) throw new Error('initialQ 需为有限数');

  const index = buildIndex(world, options);
  const { rows, cols, rowIndex, nonGoal, avail, availList } = index;
  const Q: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(initialQ));
  const rng = mulberry32(seed);
  const stepsPerEpisode: number[] = [];
  const returnsPerEpisode: number[] = [];
  let totalSteps = 0;

  for (let ep = 0; ep < episodes; ep += 1) {
    let s = pickStartCell(nonGoal, config.startCell, 'learner', rng);
    let steps = 0;
    let ret = 0;
    let done = false;
    while (steps < cap && !done) {
      const startRow = rowIndex.get(s)!;
      const omega = pickOption(availList[startRow], Q[startRow], epsilon, rng, tieBreak);
      // ── 执行宏 ω: 按 π_ω 原步推进直至 β=1 / 达目标 / 回合预算尽 ──
      // R5: 策略/终止查询走物化表（表未覆盖的态回退闭包——语义逐位同）
      let cur = s;
      let rDisc = 0;
      let rPlain = 0;
      let k = 0;
      while (steps + k < cap) {
        const curRow = rowIndex.get(cur)!;
        const a = policyAt(index, world, options, curRow, omega);
        const out = world.step(cur, a, rng);
        rDisc += Math.pow(gamma, k) * out.reward;
        rPlain += out.reward;
        ret += out.reward;
        k += 1;
        cur = out.sNext;
        if (out.done) {
          done = true;
          break;
        }
        if (betaAt(index, world, options, rowIndex.get(cur)!, omega) >= 1) break;
      }
      // ── SMDP 更新: 折价指数 = 实测宏步长（duration）/ 误用 γ¹（unit 陷阱） ──
      const curRow = rowIndex.get(cur)!;
      const nextValue = done ? 0 : maxAvailQ(avail[curRow], Q[curRow]);
      const rewardTerm = mode === 'duration' ? rDisc : rPlain;
      const exponentFactor = mode === 'duration' ? Math.pow(gamma, k) : gamma;
      const target = rewardTerm + exponentFactor * nextValue;
      Q[startRow][omega] += alpha * (target - Q[startRow][omega]);
      s = cur;
      steps += k;
    }
    stepsPerEpisode.push(steps);
    returnsPerEpisode.push(ret);
    totalSteps += steps;
  }
  return {
    Q,
    stepsPerEpisode,
    returnsPerEpisode,
    meta: { kind: 'smdp', episodes, gamma, epsilon, alpha, discountExponentMode: mode, totalSteps },
  };
}

// ─────────────────────────── 平坦 Q-learning（对照基准） ───────────────────────────

export interface FlatQLearningConfig {
  world: Gridworld;
  episodes: number;
  seed?: number;
  gamma?: number;
  epsilon?: number;
  alpha?: number;
  maxStepsPerEpisode?: number;
  initialQ?: number;
  /** 固定起始格（与 SMDP 同协议; 缺省 = 每回合随机非目标起态） */
  startCell?: number;
  /** 贪婪平局破法: 'lowest'（缺省，确定性）| 'random'（种子化——训练推荐，消除平局锁定） */
  tieBreak?: 'lowest' | 'random';
}

/** 原步 Q-learning: 同种子/同探索率/同 α——与 SMDP 的公平对照（省的是宏抽象的账） */
export function flatQLearning(config: FlatQLearningConfig): LearnerResult {
  if (!config) throw new Error('flatQLearning: 缺少配置');
  const world = config.world;
  const gamma = config.gamma ?? 0.95;
  const epsilon = config.epsilon ?? 0.15;
  const alpha = config.alpha ?? 1;
  const episodes = config.episodes;
  const seed = config.seed ?? 1;
  const cap = config.maxStepsPerEpisode ?? 8 * (world.width + world.height);
  const initialQ = config.initialQ ?? 0;
  const tieBreak = config.tieBreak ?? 'lowest';
  if (tieBreak !== 'lowest' && tieBreak !== 'random') throw new Error(`tieBreak 需为 'lowest'|'random'，收到 ${String(tieBreak)}`);
  validateCommon(gamma, epsilon, alpha, episodes, cap, seed);
  if (!Number.isFinite(initialQ)) throw new Error('initialQ 需为有限数');

  const primitives = primitiveOptions(world);
  const { rows, rowIndex, nonGoal } = buildIndex(world, primitives);
  const Q: number[][] = Array.from({ length: rows }, () => new Array<number>(4).fill(initialQ));
  const rng = mulberry32(seed);
  const stepsPerEpisode: number[] = [];
  const returnsPerEpisode: number[] = [];
  let totalSteps = 0;

  for (let ep = 0; ep < episodes; ep += 1) {
    let s = pickStartCell(nonGoal, config.startCell, 'learner', rng);
    let steps = 0;
    let ret = 0;
    let done = false;
    while (steps < cap && !done) {
      const row = rowIndex.get(s)!;
      // 原步全部可用（撞墙 = 原地是合法转移）
      let a: number;
      if (rng() < epsilon) a = Math.floor(rng() * 4) % 4;
      else if (tieBreak === 'random') {
        let mv = Q[row][0];
        for (let c = 1; c < 4; c += 1) if (Q[row][c] > mv) mv = Q[row][c];
        const argmax: number[] = [];
        for (let c = 0; c < 4; c += 1) if (Q[row][c] === mv) argmax.push(c);
        a = argmax[Math.floor(rng() * argmax.length) % argmax.length];
      } else {
        a = 0;
        for (let c = 1; c < 4; c += 1) if (Q[row][c] > Q[row][a]) a = c;
      }
      const out = world.step(s, a as Action, rng);
      const nextRow = rowIndex.get(out.sNext)!;
      const nextValue = out.done ? 0 : Math.max(Q[nextRow][0], Q[nextRow][1], Q[nextRow][2], Q[nextRow][3]);
      Q[row][a] += alpha * (out.reward + gamma * nextValue - Q[row][a]);
      s = out.sNext;
      steps += 1;
      ret += out.reward;
      done = out.done;
    }
    stepsPerEpisode.push(steps);
    returnsPerEpisode.push(ret);
    totalSteps += steps;
  }
  return { Q, stepsPerEpisode, returnsPerEpisode, meta: { kind: 'flat', episodes, gamma, epsilon, alpha, totalSteps } };
}

// ─────────────────────────── intra-option Q-learning（原步经验学技能） ───────────────────────────

export interface IntraOptionConfig {
  world: Gridworld;
  options: Option[];
  episodes: number;
  seed?: number;
  gamma?: number;
  epsilon?: number;
  alpha?: number;
  maxStepsPerEpisode?: number;
  initialQ?: number;
  /** 固定起始格（与 SMDP 同协议; 缺省 = 每回合随机非目标起态） */
  startCell?: number;
  /** 贪婪平局破法: 'lowest'（缺省，确定性）| 'random'（种子化——训练推荐，消除平局锁定） */
  tieBreak?: 'lowest' | 'random';
}

/**
 * intra-option Q-learning（Precup–Sutton）: 行为层照常执行宏，但每个原步
 * (s,a,r,s') 同时更新**所有** π_ω(s)=a 的选项:
 *   Q(s,ω) ← Q + α·[ r + γ·((1−β(s'))·Q(s',ω) + β(s')·max_{ω'∈I(s')} Q(s',ω')) − Q ]
 * 不动点 = 选项 Bellman 方程 = SMDP 宏展开形的同一个 Q*（验证锚点②双口径互证:
 * 从原步经验收敛到与宏模型值迭代完全相同的表）。
 */
export function intraOptionQLearning(config: IntraOptionConfig): LearnerResult {
  if (!config) throw new Error('intraOptionQLearning: 缺少配置');
  const world = config.world;
  const options = config.options;
  const gamma = config.gamma ?? 0.95;
  const epsilon = config.epsilon ?? 0.15;
  const alpha = config.alpha ?? 1;
  const episodes = config.episodes;
  const seed = config.seed ?? 1;
  const cap = config.maxStepsPerEpisode ?? 8 * (world.width + world.height);
  const initialQ = config.initialQ ?? 0;
  const tieBreak = config.tieBreak ?? 'lowest';
  if (tieBreak !== 'lowest' && tieBreak !== 'random') throw new Error(`tieBreak 需为 'lowest'|'random'，收到 ${String(tieBreak)}`);
  validateCommon(gamma, epsilon, alpha, episodes, cap, seed);
  if (!Number.isFinite(initialQ)) throw new Error('initialQ 需为有限数');

  const index = buildIndex(world, options);
  const { rows, cols, rowIndex, nonGoal, avail, availList } = index;
  const Q: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(initialQ));
  const rng = mulberry32(seed);
  const stepsPerEpisode: number[] = [];
  const returnsPerEpisode: number[] = [];
  let totalSteps = 0;

  for (let ep = 0; ep < episodes; ep += 1) {
    let s = pickStartCell(nonGoal, config.startCell, 'learner', rng);
    let steps = 0;
    let ret = 0;
    let done = false;
    while (steps < cap && !done) {
      const row = rowIndex.get(s)!;
      const omega = pickOption(availList[row], Q[row], epsilon, rng, tieBreak);
      let terminateOption = false;
      while (steps < cap && !done && !terminateOption) {
        const curRow = rowIndex.get(s)!;
        const a = policyAt(index, world, options, curRow, omega);
        const out = world.step(s, a, rng);
        const nextRow = rowIndex.get(out.sNext)!;
        // ── 每步更新所有一致选项（π_ω(s) = a 且 s ∈ I_ω）──
        // R5: 匹配索引 matchAvail[curRow][a]（升序）替代全列扫描——
        // 与旧「for c in 全列 + avail/一致过滤」逐位同序同值
        for (const c of index.matchAvail[curRow]![a]!) {
          const betaNext = betaAt(index, world, options, nextRow, c);
          const continueValue = betaNext >= 1 ? 0 : Q[nextRow]![c]!;
          const terminateValue = betaNext >= 1 ? maxAvailQ(avail[nextRow]!, Q[nextRow]!) : 0;
          const target = out.done ? out.reward : out.reward + gamma * (continueValue + terminateValue);
          Q[curRow]![c]! += alpha * (target - Q[curRow]![c]!);
        }
        steps += 1;
        ret += out.reward;
        done = out.done;
        s = out.sNext;
        if (!done && betaAt(index, world, options, rowIndex.get(s)!, omega) >= 1) terminateOption = true;
      }
    }
    stepsPerEpisode.push(steps);
    returnsPerEpisode.push(ret);
    totalSteps += steps;
  }
  return { Q, stepsPerEpisode, returnsPerEpisode, meta: { kind: 'intra-option', episodes, gamma, epsilon, alpha, totalSteps } };
}

// ─────────────────────────── 精确 SMDP 模型与 Bellman 残差 ───────────────────────────

/** 精确宏转移模型（确定性世界 + 确定性选项 ⟹ (k, r, s') 是 (s,ω) 的确定函数） */
export interface SmdpTransition {
  /** 实际宏步长 k ≥ 1 */
  k: number;
  /** 宏内折价累计回报 Σ γ^t·r_t */
  rDisc: number;
  /** 终止态（行号） */
  sTermRow: number;
  /** 是否中途达目标（宏提前结束） */
  done: boolean;
}

export interface SolveSmdpExactConfig {
  world: Gridworld;
  options: Option[];
  gamma?: number;
  /** 值迭代收敛容差（缺省 1e-13） */
  tol?: number;
  maxIterations?: number;
  /** 单宏展开步数上限（缺省 16·(width+height); 触顶 = 内部错误 throw——精确模型不容截断） */
  maxOptionSteps?: number;
}

export interface SmdpExactSolution {
  Q: number[][];
  /** 精确模型 [行][列]（不可启动 = undefined） */
  model: (SmdpTransition | undefined)[][];
  iterations: number;
  converged: boolean;
  /** 收敛处的 Bellman 残差（≤ tol） */
  residual: number;
  gamma: number;
}

/** 构建精确宏模型: 逐 (s,ω) 确定性展开（模拟即求值——确定性是精确断言的前提） */
function buildSmdpModel(world: Gridworld, options: Option[], gamma: number, maxOptionSteps: number): { model: (SmdpTransition | undefined)[][]; index: WorldIndex } {
  // 随机性守卫: 同种子双探针比对——slip>0 的世界会被拒绝（精确模型的数学前提）
  const probeA = mulberry32(12345);
  const probeB = mulberry32(12345);
  for (const s of [world.states[0], world.states[Math.floor(world.states.length / 2)]]) {
    for (const a of [0, 1, 2, 3] as Action[]) {
      if (world.step(s, a, probeA).sNext !== world.step(s, a, probeB).sNext) {
        throw new Error('buildSmdpModel: 精确宏模型要求确定性世界（slip>0 被拒绝——随机世界请用学习者口径，锚点②的精确断言不适用）');
      }
    }
  }
  const index = buildIndex(world, options);
  const { rows, cols, rowIndex, avail } = index;
  const model: (SmdpTransition | undefined)[][] = Array.from({ length: rows }, () => new Array<SmdpTransition | undefined>(cols).fill(undefined));
  for (let r = 0; r < rows; r += 1) {
    const s = world.states[r];
    if (s === world.goal) continue;
    for (let c = 0; c < cols; c += 1) {
      if (!avail[r][c]) continue;
      let cur = s;
      let rDisc = 0;
      let k = 0;
      let done = false;
      while (k < maxOptionSteps) {
        const a = options[c].policy(cur);
        const out = world.step(cur, a, probeA);
        rDisc += Math.pow(gamma, k) * out.reward;
        k += 1;
        cur = out.sNext;
        if (out.done) {
          done = true;
          break;
        }
        if (options[c].beta(cur) >= 1) break;
      }
      if (k >= maxOptionSteps && !done && options[c].beta(cur) < 1) {
        throw new Error(`buildSmdpModel: 选项 "${options[c].id}" 从状态 ${s} 展开 ${maxOptionSteps} 步未终止（cap 过小或策略不收敛到终止集）`);
      }
      model[r][c] = { k, rDisc, sTermRow: rowIndex.get(cur)!, done };
    }
  }
  return { model, index };
}

/**
 * 精确 SMDP 求解: 值迭代于确定性宏模型上（收缩映射 γ^k ≤ γ < 1 ⟹ 几何收敛到
 * 唯一 Q*）。作为 Q-learning 收敛断言的独立对照（同一张表，两条路到达）。
 */
export function solveSmdpExact(config: SolveSmdpExactConfig): SmdpExactSolution {
  if (!config) throw new Error('solveSmdpExact: 缺少配置');
  const gamma = config.gamma ?? 0.95;
  if (!(gamma > 0 && gamma < 1)) throw new Error(`gamma 需 ∈ (0,1)，收到 ${gamma}`);
  const tol = config.tol ?? 1e-13;
  const maxIterations = config.maxIterations ?? 50000;
  const maxOptionSteps = config.maxOptionSteps ?? 16 * (config.world.width + config.world.height);
  if (!(tol > 0) || !Number.isInteger(maxIterations) || maxIterations < 1 || !Number.isInteger(maxOptionSteps) || maxOptionSteps < 1) {
    throw new Error('solveSmdpExact: tol/maxIterations/maxOptionSteps 参数非法');
  }
  const { model, index } = buildSmdpModel(config.world, config.options, gamma, maxOptionSteps);
  const { rows, cols, avail } = index;
  const Q: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maxIterations; it += 1) {
    iterations = it + 1;
    let sup = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const t = model[r][c];
        if (t === undefined) continue;
        const nextValue = t.done ? 0 : maxAvailQ(avail[t.sTermRow], Q[t.sTermRow]);
        const next = t.rDisc + Math.pow(gamma, t.k) * nextValue;
        const diff = Math.abs(next - Q[r][c]);
        if (diff > sup) sup = diff;
        Q[r][c] = next;
      }
    }
    if (sup <= tol) {
      converged = true;
      break;
    }
  }
  const residualCheck = optionBellmanResidual({ world: config.world, options: config.options, Q, gamma, model });
  return { Q, model, iterations, converged, residual: residualCheck.maxResidual, gamma };
}

export interface OptionBellmanResidualConfig {
  world: Gridworld;
  options: Option[];
  /** 被审计的 Q（形状须为 states×options） */
  Q: number[][];
  gamma?: number;
  /** 复用外部精确模型（缺省内部重建） */
  model?: (SmdpTransition | undefined)[][];
}

export interface OptionBellmanResidualResult {
  /** max_{(s,ω)} |Q(s,ω) − [r + γ^k·max Q(s',ω')]|（SMDP Bellman 残差） */
  maxResidual: number;
  /** 残差最大处（诊断; 无可审计对时 null） */
  worst: { s: number; optionId: string; q: number; target: number } | null;
}

/**
 * SMDP Bellman 残差: 对确定性宏模型逐对计算 |Q − T Q|。
 * Q* 处为 0（机器精度）; γ¹ 陷阱 Q 处 = |γ^k − γ|·V 量级（锚点④的量化器）。
 */
export function optionBellmanResidual(config: OptionBellmanResidualConfig): OptionBellmanResidualResult {
  if (!config) throw new Error('optionBellmanResidual: 缺少配置');
  const gamma = config.gamma ?? 0.95;
  if (!(gamma > 0 && gamma < 1)) throw new Error(`gamma 需 ∈ (0,1)，收到 ${gamma}`);
  const world = config.world;
  const options = config.options;
  let model = config.model;
  let index: WorldIndex;
  if (model !== undefined) {
    index = buildIndex(world, options); // 仅取 avail/行号（不重建模型）
  } else {
    const built = buildSmdpModel(world, options, gamma, 16 * (world.width + world.height));
    model = built.model;
    index = built.index;
  }
  const { rows } = index;
  if (!Array.isArray(config.Q) || config.Q.length !== rows) throw new Error(`optionBellmanResidual: Q 需为 ${rows} 行`);
  for (const row of config.Q) {
    if (!Array.isArray(row) || row.length !== options.length) throw new Error(`optionBellmanResidual: Q 每行需 ${options.length} 列`);
    for (const v of row) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('optionBellmanResidual: Q 含非有限值');
  }
  const avail = index.avail;
  let maxResidual = 0;
  let worst: OptionBellmanResidualResult['worst'] = null;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < options.length; c += 1) {
      const t = model[r][c];
      if (t === undefined) continue;
      const nextValue = t.done ? 0 : maxAvailQ(avail[t.sTermRow], config.Q[t.sTermRow]);
      const target = t.rDisc + Math.pow(gamma, t.k) * nextValue;
      const diff = Math.abs(config.Q[r][c] - target);
      if (diff > maxResidual) {
        maxResidual = diff;
        worst = { s: world.states[r], optionId: options[c].id, q: config.Q[r][c], target };
      }
    }
  }
  return { maxResidual, worst };
}

// ─────────────────────────── 贪婪技能组合冒烟 ───────────────────────────

export interface SmokeTestConfig {
  world: Gridworld;
  options: Option[];
  Q: number[][];
  /** 起始态清单（cell; 缺省 = 种子化随机抽 rollouts 个非目标态） */
  starts?: number[];
  rollouts?: number;
  seed?: number;
  /** 冒烟步数上限（缺省 8·(width+height)） */
  maxSteps?: number;
  /** 冒烟期探索率（缺省 0 = 纯贪婪; >0 时种子化——技能组合的确定性检验用 0） */
  epsilon?: number;
  /** 贪婪平局破法（缺省 'lowest'——冒烟的确定性口径） */
  tieBreak?: 'lowest' | 'random';
}

export interface SmokeTestResult {
  /** 到达目标的比例（贪婪技能组合的成功率——锚点③） */
  successRate: number;
  /** 失败起始态清单（cell） */
  failures: number[];
  /** 每次滚动的环境步数 */
  steps: number[];
  meanSteps: number;
  rollouts: number;
}

/**
 * 技能组合冒烟: 从各起始态贪婪选宏执行到目标——DAG 式「选技能 → 跑完 → 再选」
 * 的闭环检验。平局取最小列号（确定性; ε=0 时同输入同输出）。
 */
export function smokeTestPolicy(config: SmokeTestConfig): SmokeTestResult {
  if (!config) throw new Error('smokeTestPolicy: 缺少配置');
  const index = buildIndex(config.world, config.options);
  const { rows, cols, rowIndex, nonGoal, avail, availList } = index;
  const Q = config.Q;
  if (!Array.isArray(Q) || Q.length !== rows) throw new Error(`smokeTestPolicy: Q 需为 ${rows} 行`);
  for (const row of Q) {
    if (!Array.isArray(row) || row.length !== cols) throw new Error(`smokeTestPolicy: Q 每行需 ${cols} 列`);
    for (const v of row) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('smokeTestPolicy: Q 含非有限值');
  }
  const epsilon = config.epsilon ?? 0;
  const tieBreak = config.tieBreak ?? 'lowest';
  if (!(epsilon >= 0 && epsilon <= 1)) throw new Error(`epsilon 需 ∈ [0,1]，收到 ${epsilon}`);
  if (tieBreak !== 'lowest' && tieBreak !== 'random') throw new Error(`tieBreak 需为 'lowest'|'random'，收到 ${String(tieBreak)}`);
  const maxSteps = config.maxSteps ?? 8 * (config.world.width + config.world.height);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps 需为正整数');
  const rng = mulberry32(config.seed ?? 1);
  let starts = config.starts;
  if (starts === undefined) {
    const rollouts = config.rollouts ?? 200;
    if (!Number.isInteger(rollouts) || rollouts < 1) throw new Error('rollouts 需为正整数');
    starts = Array.from({ length: rollouts }, () => nonGoal[Math.floor(rng() * nonGoal.length) % nonGoal.length]);
  } else {
    if (!Array.isArray(starts) || starts.length === 0) throw new Error('starts 需为非空数组');
    for (const s of starts) {
      if (!rowIndex.has(s)) throw new Error(`smokeTestPolicy: 起始态 ${s} 不在 states 中`);
      if (s === config.world.goal) throw new Error('smokeTestPolicy: 起始态不得为目标本身');
    }
  }

  const world = config.world;
  const options = config.options;
  const stepsOut: number[] = [];
  const failures: number[] = [];
  for (const start of starts!) {
    let s = start;
    let steps = 0;
    let success = false;
    while (steps < maxSteps) {
      const row = rowIndex.get(s)!;
      const omega = pickOption(availList[row], Q[row], epsilon, rng, tieBreak);
      let cur = s;
      while (steps < maxSteps) {
        const a = policyAt(index, world, options, rowIndex.get(cur)!, omega);
        const out = world.step(cur, a, rng);
        steps += 1;
        cur = out.sNext;
        if (out.done) {
          success = true;
          break;
        }
        if (betaAt(index, world, options, rowIndex.get(cur)!, omega) >= 1) break;
      }
      s = cur;
      if (success) break;
    }
    stepsOut.push(steps);
    if (!success) failures.push(start);
  }
  const total = stepsOut.reduce((a, b) => a + b, 0);
  return { successRate: 1 - failures.length / starts!.length, failures, steps: stepsOut, meanSteps: total / starts!.length, rollouts: starts!.length };
}

/* ── 接线建议 ──
 * 建议挂载引擎: 任务执行器（DAG 计划节点的技能宏与长计划时间信用分配）、
 * 经验沉淀进化（技能库 = 有名字、有入口/终止条件的可复用子程序）。
 *   1. 任务执行器: DAG 计划节点即 option——I_ω = 前置条件满足的世界态，
 *      π_ω = 节点子程序（工具调用序列），β_ω = 完成谓词（产出验收）。
 *      长计划信用分配用 smdpQLearning 口径: 节点耗时 k 步则折扣 γ^k（时间
 *      信用按真实墙钟/步数折价），r = 节点内折价累计效用——「这个子计划值
 *      得进主计划」从原步信号升级为宏动作信号，γ^n 渗回流问题随之消解。
 *   2. 技能库沉淀: hallwayOptions 的构造模式（技能 = 导航到里程碑）映射为
 *      「执行到检查点」类技能; primitiveOptions 混入保证任意态可决策
 *      （永不因技能不适用而卡死——buildIndex 的覆盖性校验即该不变量）。
 *   3. intra-option 通道: 执行器照常跑计划（行为层），沉淀侧用
 *      intraOptionQLearning 从原始执行轨迹学技能价值——无需专门「执行技能
 *      做实验」，经验复用是白捡的。
 *   4. 缺省关闭旗标名: enableOptionsFrameworkKernel（缺省 false; 关闭时计划
 *      走原贪心组装与原步归因路径，行为逐位一致——纯分析内核零介入）。
 *   5. 挂载后改变的决策点: ① 子计划选择（贪心 → 宏 Q 贪婪）; ② 计划复盘
 *      归因（原步口径 → γ^k 宏口径）; ③ 技能复用决策（经验沉淀进化读宏 Q
 *      决定哪些子程序值得保留为技能）。运行时账单: stepsPerEpisode（样本
 *      效率）与 optionBellmanResidual（价值表健康度）可审计。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
