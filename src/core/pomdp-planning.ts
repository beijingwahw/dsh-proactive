/**
 * 84.0 部分可观察规划内核 —— 信念贝叶斯更新 · α-向量精确值迭代 · QMDP 上界
 *
 * 动机: 29.0 MCTS 与 83.0 世界模型都假设状态可读；真实调度里引擎看到的往往
 * 只是症状（超时、报错、用户沉默）而非根因。POMDP 把「状态不可读」变成一等
 * 问题：信念 b（|S| 维分布）才是真正的决策状态，信息（观测）有价格、采集
 * （探测/询问/等待）是动作。defer/execute/ask-user 的判断层需要的是「多值
 * 一比特信息」的精确口径——本内核提供精确有限视界解与其上界近似。
 *
 * 数学:
 *   信念更新（贝叶斯，精确归一）:
 *     b'(s') ∝ O(o|s',a) · Σ_s T(s'|s,a)·b(s)，
 *     P(o|b,a) = Σ_{s'} O(o|s',a)·Σ_s T(s'|s,a)·b(s)（未归一化总和）。
 *   α-向量值迭代（有限视界精确，Smallwood & Sondik 1973）:
 *     V_t(b) = max_α α·b，V₀ ≡ 0；备份
 *     Γ_{t+1} = ⋃_a { r_a + γ·⊕_o Γ^{a,o} }，其中直和跨观测、
 *     Γ^{a,o} = { w: w(s) = Σ_{s'} T(s'|s,a)·O(o|s',a)·α(s'), α ∈ Γ_t }。
 *     V_{t+1}(b) = max_a [ r_a·b + γ Σ_o P(o|b,a)·V_t(τ(b,a,o)) ] 的
 *     线性函数精确表示（逐信念点与暴力信念树一致——锚点②）。
 *     裁剪（只删「任何信念下都不再严格最优」的向量，恒保值函数精确）:
 *       · 逐点支配（某向量在全部坐标 ≤ 另一向量）——任意维度可用；
 *       · 支撑两坐标时升级为凸包前沿裁剪（对支撑含于该两态的信念精确：
 *         信念在 2-单纯形边上，价值 = 线函数的上包络，只需包络顶点）——
 *         tigerPomdp 的可达信念恒在 (tiger-left, tiger-right) 支撑上，且
 *         done 态零奖励吸收、其坐标流经 O ≤ 1 缩放不产生新的支撑外最大值
 *         （开口向量恒为信念端点极点、同支撑坐标重复时保留 done 坐标最大者），
 *         锚点②以暴力树在 H=3、4 逐信念点数值验证。
 *   QMDP（Littman et al. 1995）: 假设「再盲一步、之后全可观」，在底层 MDP 上
 *     值迭代得 Q(s,a)，V_QMDP(b) = max_a Σ_s b(s)·Q(s,a) ≥ V*(b)——信息免费的
 *     上界；与精确值之差是「一步后全知」的信息价值口径（锚点④）。
 *   Tiger（Kaelbling, Littman & Cassandra 1998）: 两门虎经典参数
 *     （听 −1、开对 +10、开错 −100、听准 0.85、γ=1、开门终局）作锚点域。
 *
 * 验证锚点（scripts/verify-model-pomdp.mjs，全确定——本内核无随机源）:
 *   ① 信念更新手算：均匀信念连听两次同侧 → b(tiger-left) = 0.85 →
 *      0.85²/(0.85²+0.15²) = 289/298 ≈ 0.969799（1e-12 精确；规格口述的
 *      0.925 非本参数口径，脚本按手算精确值断言）；异侧两听相消 → 0.5 精确。
 *   ② α-VI vs 暴力信念树：同视界（H=3、4）在信念网格上逐点一致 <1e-9
 *      （两套独立实现算同一个 V_H，互相证明无裁剪误差、无备份错向）。
 *   ③ Tiger 经典值：最优首动作恒为「听」（H ∈ {1..30}）；V_H(0.5) 手算
 *      H=1 → −1、H=2 → −2、H=3 → 2.72 精确（V₂(0.85) = −1+0.745·6.6779−
 *      0.255 = 3.72，其中 P(同侧|b=0.85) = 0.85²+0.15² = 0.745 恰好约去）；
 *      H→∞ 的信念格点不动点 v(0.5) = v(0.85)−1、v(0.85) = −1+0.745·v(0.97)
 *      +0.255·v(0.5)、v(0.97) = 6.7899+0.17114·v(0.85) ⟹ v(0.5) ≈ 5.159
 *      （γ=1 开门终局口径）；H=30 时 |V−5.159| < 0.01（容差 = 手算格点圆整）。
 *   ④ QMDP ≥ 精确：Tiger γ=1 时 V_QMDP(0.5) = 9 精确（解析：V(s)=10、
 *      Q(listen) = 9）≥ 精确值 5.16，差 ≈ 3.84 即信息价值；网格逐点 ≥。
 *   ⑤ 无信息观测退化：O 均匀 ⟹ 信念更新与观测解耦，POMDP 值 = 信念上的
 *      开环 MDP 值（逐位 <1e-9）；恒定动作在底层 MDP 处处最优时 = 对应
 *      MDP 值（逐位）；反之严格小于（信息不可得的损失，构造域解析 = 2）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】PBVI 点集价值迭代（Pineau, Gordon & Thrun 2003）：
 *    在有限信念点集 B 上做 Bellman 备份——每个点 b 取
 *        argmax_a [ r_a·b + γ Σ_o max_{α∈Γ} α·τ(b,a,o) ]
 *    的支撑向量（α*_o 按点逐观测选取——点基近似的全部近似性所在），
 *    Γ 每轮替换为 |B| 个备份向量。数学保证：Γ₀={0}（V₀≡0 ≤ V*）起，
 *    **单调 Bellman 算子**保证各备份点的值逐轮不降且恒 ≤ V*（下界
 *    近似）——与 QMDP 上界夹出真值的区间 [PBVI, QMDP]，区间宽即
 *    「信息价值的可解释残差」。与精确 α-VI 的分工：α-VI 指数爆炸
 *    （|Γ| 随视界 |O|^H 增长），PBVI 复杂度 O(迭代 × |B| × |A||O||S|²·|Γ|)，
 *    长视界/大域上唯一可负担的口径。
 *
 * A2【性能进化】α 向量支配检验的关键坐标预过滤：j 支配 i 要求 α_j
 *    逐坐标 ≥ α_i——必要条件 α_j 在**散布最大坐标** k* 上也不低于
 *    α_i（α_j[k*] ≥ α_i[k*] − 1e-12）。预计算各向量在 k* 的键值
 *    （O(n·|S|) 一次性），不满足必要条件的对 O(1) 跳过——**判定逐位
 *    等价**：被跳过的对在旧全对比路径也必然判「不支配」，保留集不变
 *    （verify-r5 以 200+ 种子对照 alphas/actions/sizes 全等 + 跳过率
 *    与耗时统计）。
 *
 * A3【数值稳健】预过滤阈值与支配容差同源（1e-12——跳过边界与判定
 *    容差一致，不引入新的数值语义）；PBVI 的 τ 用未归一化后验
 *    （省一次除法与归一化误差累积），备份向量 = 精确线性组合。
 *
 * A4【性质测试】① 凸性（PWLC）：V(λb₁+(1−λ)b₂) ≤ λV(b₁)+(1−λ)V(b₂)
 *    （凸 = 曲线在弦下方——α-VI 的 valueAt 是分段线性凸函数的极大值
 *    包络），200+ 种子 (b₁,b₂,λ) 三元组验证；② 夹逼：PBVI(b) ≤ 精确
 *    同视界值 ≤ QMDP(b)（PBVI 向量逐个是截断条件计划的值 ⟹ 逐点 ≤
 *    V_H；Tiger 信念格与随机信念双口径）；③ 点集加密 → PBVI 间隙收
 *    敛（下界方向收紧）。诚实注记：PBVI 点值跨轮**不保证单调**（Γ
 *    替换后非点后继信念的估值可下拉备份值——B V_t(b) 依赖 V_t 在
 *    τ(b,a,o) 处的值，那些点不在 B 里）。
 */

// ─────────────────────────── 类型与校验 ───────────────────────────

/** 离散 POMDP：T[s][a][s'] 转移、O[a][s'][o] 观测、R[s][a] 期望奖励 */
export interface POMDP {
  readonly name: string;
  readonly states: string[];
  readonly actions: string[];
  readonly observations: string[];
  readonly transitions: number[][][];
  readonly O: number[][][];
  readonly rewards: number[][];
  readonly gamma: number;
}

export interface AlphaVIOptions {
  /**
   * 只在这些状态坐标上做支配/凸包裁剪（缺省 = 全坐标逐点支配，恒精确）。
   * 支撑两坐标时启用凸包前沿裁剪——对支撑含于这些状态的信念精确。
   * 典型用法：带吸收零奖励终态的域传 [非终态下标...]（如 tiger 的 [0,1]）。
   */
  pruneSupport?: number[];
  /**
   * R5：支配检验关键坐标预过滤（缺省 true）。必要条件：j 支配 i ⟹
   * 在散布最大坐标 k* 上 α_j[k*] ≥ α_i[k*] − 1e-12；不满足则 O(1) 跳过
   * ——判定与旧全对比路径逐位等价（跳过的对必不支配，保留集不变）。
   * false = 旧路径（对照/审计）。
   */
  pruneFast?: boolean;
}

/** R5：α 裁剪统计（pruneFast 的等价性证据 + 跳过率审计） */
export interface PruneStats {
  /** 执行过的支配对比次数 */
  checks: number;
  /** 预过滤跳过的对比次数（checks + skipped = 全对比路径本应执行的次数） */
  skipped: number;
}

export interface AlphaVIResult {
  /** Γ_H：|Γ|×|S| α-向量（空 = 视界 0，V ≡ 0） */
  readonly alphas: number[][];
  /** 每个 α-向量的贪心动作下标 */
  readonly actions: number[];
  readonly horizon: number;
  /** 每视界层裁剪后 |Γ_t|（增长审计） */
  readonly sizes: number[];
  /** V_H(b) = max_α α·b（信念只读闭包） */
  readonly valueAt: (b: number[]) => number;
  /** R5：本次运行的支配检验统计（等价性证据 + 预过滤跳过率审计） */
  readonly pruneStats: PruneStats;
}

/** 结构校验（维度、概率行和、γ），非法即 throw——所有入口共用 */
export function validatePomdp(pomdp: POMDP): void {
  const nS = pomdp.states.length;
  const nA = pomdp.actions.length;
  const nO = pomdp.observations.length;
  if (nS === 0 || nA === 0 || nO === 0) throw new Error('pomdp: states/actions/observations 不得为空');
  if (pomdp.transitions.length !== nS) throw new Error('pomdp: T 第一维与状态数不匹配');
  if (pomdp.O.length !== nA || (pomdp.O[0]?.length ?? 0) !== nS) {
    throw new Error('pomdp: O 维度必须为 [动作][后继状态][观测]');
  }
  if (pomdp.rewards.length !== nS || (pomdp.rewards[0]?.length ?? 0) !== nA) {
    throw new Error('pomdp: R 维度必须为 [状态][动作]');
  }
  if (!(pomdp.gamma > 0 && pomdp.gamma <= 1)) throw new Error(`pomdp: gamma ∈ (0,1]（收到 ${pomdp.gamma}）`);
  for (let s = 0; s < nS; s += 1) {
    if (pomdp.transitions[s]!.length !== nA) throw new Error('pomdp: T 第二维与动作数不匹配');
    for (let a = 0; a < nA; a += 1) {
      const row = pomdp.transitions[s]![a]!;
      if (row.length !== nS) throw new Error('pomdp: T 第三维与状态数不匹配');
      let sum = 0;
      for (const p of row) {
        if (!Number.isFinite(p) || p < 0) throw new Error('pomdp: 转移概率必须有限非负');
        sum += p;
      }
      if (Math.abs(sum - 1) > 1e-6) throw new Error(`pomdp: T[${s}][${a}] 行和 ${sum} ≠ 1`);
      if (!Number.isFinite(pomdp.rewards[s]![a]!)) throw new Error('pomdp: 奖励必须有限');
    }
  }
  for (let a = 0; a < nA; a += 1) {
    for (let s2 = 0; s2 < nS; s2 += 1) {
      const row = pomdp.O[a]![s2]!;
      if (row.length !== nO) throw new Error('pomdp: O 第三维与观测数不匹配');
      let sum = 0;
      for (const p of row) {
        if (!Number.isFinite(p) || p < 0) throw new Error('pomdp: 观测概率必须有限非负');
        sum += p;
      }
      if (Math.abs(sum - 1) > 1e-6) throw new Error(`pomdp: O[${a}][${s2}] 行和 ${sum} ≠ 1`);
    }
  }
}

function validateBelief(pomdp: POMDP, b: number[], who: string): void {
  if (b.length !== pomdp.states.length) throw new Error(`${who}: 信念维度与状态数不匹配`);
  let sum = 0;
  for (const p of b) {
    if (!Number.isFinite(p) || p < 0 || p > 1 + 1e-9) throw new Error(`${who}: 信念分量必须是 [0,1] 内有限数`);
    sum += p;
  }
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`${who}: 信念和 ${sum} ≠ 1`);
}

function validateActionIndex(pomdp: POMDP, a: number, who: string): void {
  if (!Number.isInteger(a) || a < 0 || a >= pomdp.actions.length) throw new Error(`${who}: 动作下标越界（收到 ${a}）`);
}

function validateObservationIndex(pomdp: POMDP, o: number, who: string): void {
  if (!Number.isInteger(o) || o < 0 || o >= pomdp.observations.length) throw new Error(`${who}: 观测下标越界（收到 ${o}）`);
}

// ─────────────────────────── 信念更新 ───────────────────────────

/**
 * 贝叶斯信念更新：b'(s') ∝ O(o|s',a)·Σ_s T(s'|s,a)b(s)（精确归一）。
 * 返回后验信念与该观测的预测概率 P(o|b,a)。
 */
export function beliefUpdate(pomdp: POMDP, b: number[], a: number, o: number): { belief: number[]; pObservation: number } {
  validatePomdp(pomdp);
  validateBelief(pomdp, b, 'pomdp/beliefUpdate');
  validateActionIndex(pomdp, a, 'pomdp/beliefUpdate');
  validateObservationIndex(pomdp, o, 'pomdp/beliefUpdate');
  const nS = pomdp.states.length;
  const unnorm = new Array<number>(nS).fill(0);
  let pObs = 0;
  for (let s2 = 0; s2 < nS; s2 += 1) {
    let forward = 0;
    for (let s = 0; s < nS; s += 1) forward += pomdp.transitions[s]![a]![s2]! * b[s]!;
    unnorm[s2] = pomdp.O[a]![s2]![o]! * forward;
    pObs += unnorm[s2]!;
  }
  if (pObs < 1e-12) throw new Error(`pomdp/beliefUpdate: 观测 ${pomdp.observations[o]} 在动作 ${pomdp.actions[a]} 下概率 ≈ 0（${pObs}），信念无定义`);
  const belief = unnorm.map((v) => v / pObs);
  return { belief, pObservation: pObs };
}

// ─────────────────────────── α-向量精确值迭代 ───────────────────────────

/** 支配判定：dom[k] ≥ v[k] − tol 对全部考察坐标成立 */
function dominates(dom: number[], v: number[], coords: number[], tol: number): boolean {
  for (const k of coords) if (dom[k]! < v[k]! - tol) return false;
  return true;
}

/**
 * 裁剪：返回保留的下标列表（顺序稳定，删除顺序确定性）。
 * · 全坐标模式（coords = null）：逐点支配，恒精确（任何信念下值不变）。
 * · 两坐标模式：同支撑坐标去重（保留支撑外坐标和最大者——吸收态坐标即
 *   done-值流）→ Pareto 前沿 → 上凸包包络；对支撑含于该两态的信念精确。
 * · ≥3 坐标支撑：仅逐点支配（精确凸组合裁剪需 LP，本内核诚实不做）。
 * R5：两个逐点支配路径挂关键坐标预过滤（fast，缺省开）——j 支配 i
 * 的必要条件是在散布最大坐标 k* 上 α_j[k*] ≥ α_i[k*] − 1e-12（支配
 * 要求逐坐标 ≥，k* 上的违反即否决），不满足的对 O(1) 跳过；判定逐位
 * 等价，保留集不变。
 */
function pruneKeep(vectors: number[][], coords: number[] | null, stats?: PruneStats, fast = true): number[] {
  const n = vectors.length;
  if (n <= 1) return vectors.map((_, i) => i);

  if (coords === null) {
    const allCoords = vectors[0]!.map((_, k) => k);
    const filter = prefilter(vectors, allCoords, fast);
    const keep: number[] = [];
    for (let i = 0; i < n; i += 1) {
      let dominated = false;
      for (let j = 0; j < n && !dominated; j += 1) {
        if (j === i) continue;
        if (filter !== null && !filter.canDominate(j, i, stats)) continue;
        if (stats !== undefined) stats.checks += 1;
        const ge = dominates(vectors[j]!, vectors[i]!, allCoords, 1e-12);
        if (!ge) continue;
        // 平局（完全相等）时只删下标大者，保序确定
        let strictly = false;
        for (let k = 0; k < vectors[i]!.length; k += 1) {
          if (vectors[j]![k]! > vectors[i]![k]! + 1e-12) {
            strictly = true;
            break;
          }
        }
        if (strictly || j < i) dominated = true;
      }
      if (!dominated) keep.push(i);
    }
    return keep;
  }

  if (coords.length === 1) {
    const c = coords[0]!;
    let best = 0;
    for (let i = 1; i < n; i += 1) if (vectors[i]![c]! > vectors[best]![c]!) best = i;
    return [best];
  }

  if (coords.length === 2) {
    const [cx, cy] = [coords[0]!, coords[1]!];
    const offSum = (v: number[]): number => {
      let s = 0;
      for (let k = 0; k < v.length; k += 1) if (k !== cx && k !== cy) s += v[k]!;
      return s;
    };
    // ① 同支撑坐标去重：保留支撑外坐标和最大者（done-值流安全）
    const byKey = new Map<string, number>();
    for (let i = 0; i < n; i += 1) {
      const key = `${vectors[i]![cx]!.toFixed(12)},${vectors[i]![cy]!.toFixed(12)}`;
      const hit = byKey.get(key);
      if (hit === undefined || offSum(vectors[i]!) > offSum(vectors[hit]!)) byKey.set(key, i);
    }
    const cand = [...byKey.values()];
    // ② Pareto 前沿（最大化）：按 x 降序扫，保留 y 严格新高达
    cand.sort((i, j) => vectors[j]![cx]! - vectors[i]![cx]! || vectors[j]![cy]! - vectors[i]![cy]!);
    const pareto: number[] = [];
    let bestY = Number.NEGATIVE_INFINITY;
    for (const i of cand) {
      const y = vectors[i]![cy]!;
      if (y > bestY + 1e-12) {
        pareto.push(i);
        bestY = y;
      }
    }
    // ③ 上凸包包络（x 升序 = y 降序）：删去落在弦上/下的点
    pareto.reverse(); // x 升序
    const chain: number[] = [];
    for (const i of pareto) {
      while (chain.length >= 2) {
        const aIdx = chain[chain.length - 2]!;
        const bIdx = chain[chain.length - 1]!;
        const a = vectors[aIdx]!;
        const b = vectors[bIdx]!;
        const c = vectors[i]!;
        // b 在弦 (a,c) 上或下方 ⟺ (b.y−a.y)(c.x−a.x) ≤ (c.y−a.y)(b.x−a.x)
        const lhs = (b[cy]! - a[cy]!) * (c[cx]! - a[cx]!);
        const rhs = (c[cy]! - a[cy]!) * (b[cx]! - a[cx]!);
        if (lhs <= rhs + 1e-9) chain.pop();
        else break;
      }
      chain.push(i);
    }
    return chain.sort((p, q) => p - q);
  }

  // ≥3 坐标支撑：逐点支配（考察坐标限制在支撑内）
  const filter = prefilter(vectors, coords, fast);
  const keep: number[] = [];
  for (let i = 0; i < n; i += 1) {
    let dominated = false;
    for (let j = 0; j < n && !dominated; j += 1) {
      if (j === i) continue;
      if (filter !== null && !filter.canDominate(j, i, stats)) continue;
      if (stats !== undefined) stats.checks += 1;
      if (!dominates(vectors[j]!, vectors[i]!, coords, 1e-12)) continue;
      let strictly = false;
      for (const k of coords) {
        if (vectors[j]![k]! > vectors[i]![k]! + 1e-12) {
          strictly = true;
          break;
        }
      }
      if (strictly || j < i) dominated = true;
    }
    if (!dominated) keep.push(i);
  }
  return keep;
}

/**
 * R5：支配预过滤——「j 支配 i」的必要条件检查器。
 * 选散布最大的坐标 k*（max−min 逐坐标计算后取 argmax）：支配（含
 * 1e-12 容差）要求**每个**坐标 α_j[k] ≥ α_i[k] − 1e-12，特别地
 * α_j[k*] ≥ α_i[k*] − 1e-12。不满足的对 O(1) 跳过（计入 stats.skipped）；
 * 判定结果与全对比路径逐位一致（跳过的对在旧路径必判「不支配」）。
 */
function prefilter(
  vectors: number[][],
  coords: readonly number[],
  fast: boolean,
): { canDominate: (j: number, i: number, stats?: PruneStats) => boolean } | null {
  if (!fast || vectors.length === 0) return null;
  const n = vectors.length;
  let kStar = coords[0]!;
  let bestSpread = Number.NEGATIVE_INFINITY;
  for (const k of coords) {
    let mx = Number.NEGATIVE_INFINITY;
    let mn = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      const v = vectors[i]![k]!;
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    const spread = mx - mn;
    if (spread > bestSpread) {
      bestSpread = spread;
      kStar = k;
    }
  }
  const key = new Array<number>(n);
  for (let i = 0; i < n; i += 1) key[i] = vectors[i]![kStar]!;
  return {
    canDominate: (j: number, i: number, stats?: PruneStats): boolean => {
      if (key[j]! < key[i]! - 1e-12) {
        if (stats !== undefined) stats.skipped += 1;
        return false;
      }
      return true;
    },
  };
}

/**
 * α-向量值迭代（有限视界精确）。Γ 从空集（V₀≡0）起逐层备份：
 * 每 (a,o) 变换集 → 跨观测直和 + 即时奖励 → 裁剪（见 pruneKeep）。
 * 复杂度随视界呈 |O| 指数增长，长视界域请配 pruneSupport（两坐标凸包）使用。
 */
export function alphaVectorVI(pomdp: POMDP, horizon: number, opts: AlphaVIOptions = {}): AlphaVIResult {
  validatePomdp(pomdp);
  if (!Number.isInteger(horizon) || horizon < 0) throw new Error(`pomdp/alphaVectorVI: horizon ≥0 整数（收到 ${horizon}）`);
  let support: number[] | null = null;
  if (opts.pruneSupport !== undefined) {
    if (opts.pruneSupport.length === 0) throw new Error('pomdp/alphaVectorVI: pruneSupport 非空');
    const seen = new Set<number>();
    for (const k of opts.pruneSupport) {
      if (!Number.isInteger(k) || k < 0 || k >= pomdp.states.length) {
        throw new Error(`pomdp/alphaVectorVI: pruneSupport 下标越界（${k}）`);
      }
      if (seen.has(k)) throw new Error('pomdp/alphaVectorVI: pruneSupport 含重复下标');
      seen.add(k);
    }
    support = [...opts.pruneSupport];
  }

  const nS = pomdp.states.length;
  const nA = pomdp.actions.length;
  const nO = pomdp.observations.length;
  const gamma = pomdp.gamma;

  // 每动作可能的观测（P(o|s,a) 全为零的 o 不参与直和——开门动作只 branching none）
  const obsOfAction: number[][] = [];
  for (let a = 0; a < nA; a += 1) {
    const list: number[] = [];
    for (let o = 0; o < nO; o += 1) {
      let p = 0;
      for (let s = 0; s < nS; s += 1) for (let s2 = 0; s2 < nS; s2 += 1) p += pomdp.transitions[s]![a]![s2]! * pomdp.O[a]![s2]![o]!;
      if (p > 1e-12) list.push(o);
    }
    if (list.length === 0) throw new Error(`pomdp/alphaVectorVI: 动作 ${pomdp.actions[a]} 下无任何可能观测`);
    obsOfAction.push(list);
  }

  let alphas: number[][] = [];
  let actions: number[] = [];
  const sizes: number[] = [];
  // R5：预过滤开关 + 等价性审计统计
  const pruneFast = opts.pruneFast ?? true;
  const pruneStats: PruneStats = { checks: 0, skipped: 0 };

  for (let t = 1; t <= horizon; t += 1) {
    const unionAlphas: number[][] = [];
    const unionActions: number[] = [];
    for (let a = 0; a < nA; a += 1) {
      // 起步：即时奖励向量 r_a
      let acc: number[][] = [pomdp.rewards.map((row) => row[a]!)];
      for (const o of obsOfAction[a]!) {
        // Γ^{a,o} 变换集（Γ 空时 = {零向量}）
        const trans: number[][] =
          alphas.length === 0
            ? [new Array<number>(nS).fill(0)]
            : alphas.map((alpha) => {
                const w = new Array<number>(nS).fill(0);
                for (let s = 0; s < nS; s += 1) {
                  let acc2 = 0;
                  for (let s2 = 0; s2 < nS; s2 += 1) acc2 += pomdp.transitions[s]![a]![s2]! * pomdp.O[a]![s2]![o]! * alpha[s2]!;
                  w[s] = acc2;
                }
                return w;
              });
        const transKeep = pruneKeep(trans, support, pruneStats, pruneFast);
        // 跨观测直和（部分和裁剪防爆炸：部分和的支配 ⟹ 完整和的支配）
        const next: number[][] = [];
        for (const cur of acc) {
          for (const ki of transKeep) {
            const w = trans[ki]!;
            const v = new Array<number>(nS);
            for (let s = 0; s < nS; s += 1) v[s] = cur[s]! + gamma * w[s]!;
            next.push(v);
          }
        }
        acc = next;
        if (acc.length > 1) {
          const keep = pruneKeep(acc, support, pruneStats, pruneFast);
          acc = keep.map((i) => acc[i]!);
        }
      }
      for (const v of acc) {
        unionAlphas.push(v);
        unionActions.push(a);
      }
    }
    const keepUnion = pruneKeep(unionAlphas, support, pruneStats, pruneFast);
    alphas = keepUnion.map((i) => unionAlphas[i]!);
    actions = keepUnion.map((i) => unionActions[i]!);
    sizes.push(alphas.length);
  }

  return {
    alphas,
    actions,
    horizon,
    sizes,
    valueAt: (b: number[]) => beliefValue(alphas, b),
    pruneStats,
  };
}

/** V(b) = max_α α·b（Γ 空 ⟹ 0） */
export function beliefValue(alphas: number[][], b: number[]): number {
  if (alphas.length === 0) return 0;
  const nS = alphas[0]!.length;
  if (b.length !== nS) throw new Error(`pomdp/beliefValue: 信念维度与 α 维度不匹配（${b.length} vs ${nS}）`);
  let best = Number.NEGATIVE_INFINITY;
  for (const alpha of alphas) {
    let acc = 0;
    for (let s = 0; s < nS; s += 1) acc += alpha[s]! * b[s]!;
    if (acc > best) best = acc;
  }
  return best;
}

/** 信念处的贪心动作（最大化 α·b 的向量所携带的动作） */
export function greedyActionAt(alphas: number[][], actions: number[], b: number[]): number {
  if (alphas.length === 0) throw new Error('pomdp/greedyActionAt: α 集为空（视界 0 无动作）');
  if (actions.length !== alphas.length) throw new Error('pomdp/greedyActionAt: actions 与 alphas 长度不一致');
  const nS = alphas[0]!.length;
  if (b.length !== nS) throw new Error('pomdp/greedyActionAt: 信念维度与 α 维度不匹配');
  let bestIdx = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < alphas.length; i += 1) {
    let acc = 0;
    for (let s = 0; s < nS; s += 1) acc += alphas[i]![s]! * b[s]!;
    if (acc > best + 1e-15) {
      best = acc;
      bestIdx = i;
    }
  }
  return actions[bestIdx]!;
}

// ─────────────────────────── 暴力信念树（独立对照） ───────────────────────────

/**
 * 暴力信念树评估（锚点②的对照实现）：逐层展开
 * V_h(b) = max_a [ r_a·b + γ Σ_o P(o|b,a)·V_{h−1}(τ(b,a,o)) ]。
 * 与 α-VI 无共享代码路径——两者一致 ⟹ 备份方向、裁剪、归一化全对。
 * 复杂度 (|A|·|O|)^H，只适合小视界对照。
 */
export function beliefTreeEvaluate(pomdp: POMDP, b0: number[], horizon: number): number {
  validatePomdp(pomdp);
  validateBelief(pomdp, b0, 'pomdp/beliefTreeEvaluate');
  if (!Number.isInteger(horizon) || horizon < 0) throw new Error(`pomdp/beliefTreeEvaluate: horizon ≥0 整数（收到 ${horizon}）`);
  const nS = pomdp.states.length;
  const nA = pomdp.actions.length;
  const nO = pomdp.observations.length;
  const gamma = pomdp.gamma;

  const rec = (b: number[], h: number): number => {
    if (h === 0) return 0;
    let best = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < nA; a += 1) {
      let imm = 0;
      for (let s = 0; s < nS; s += 1) imm += b[s]! * pomdp.rewards[s]![a]!;
      let future = 0;
      for (let o = 0; o < nO; o += 1) {
        const unnorm = new Array<number>(nS).fill(0);
        let pObs = 0;
        for (let s2 = 0; s2 < nS; s2 += 1) {
          let forward = 0;
          for (let s = 0; s < nS; s += 1) forward += pomdp.transitions[s]![a]![s2]! * b[s]!;
          unnorm[s2] = pomdp.O[a]![s2]![o]! * forward;
          pObs += unnorm[s2]!;
        }
        if (pObs <= 1e-15) continue;
        const nb = unnorm.map((v) => v / pObs);
        future += pObs * rec(nb, h - 1);
      }
      const val = imm + gamma * future;
      if (val > best) best = val;
    }
    return best;
  };
  return rec(b0, horizon);
}

// ─────────────────────────── R5：PBVI 点集价值迭代 ───────────────────────────

/** PBVI 结果：点基 α 集 + 收敛审计 */
export interface PbviResult {
  /** 每个信念点一个备份向量（|B|×|S|） */
  readonly alphas: number[][];
  /** 每个备份向量的贪心动作下标 */
  readonly actions: number[];
  /** 备份轮数 */
  readonly iterations: number;
  /** 每轮各信念点的备份值（轮 × 点；Bellman 单调性审计——逐轮不降） */
  readonly pointValues: number[][];
  /** V(b) = max_α α·b（点基下界；信念只读闭包） */
  readonly valueAt: (b: number[]) => number;
}

/**
 * PBVI 点集价值迭代（Pineau, Gordon & Thrun 2003，R5 A1）。
 *
 * 每轮对每个信念点 b 做 Bellman 备份：
 *   V'(b) = max_a [ r_a·b + γ Σ_o max_{α∈Γ} α·τ(b,a,o) ]
 * 其中 τ(b,a,o) 为**未归一化**后验向量（Σ_s' τ = P(o|b,a)——max_α 的
 * 逐观测选取正是「信息条件下的最优未来」的点基近似），备份向量
 *   v(s) = r(s,a*) + γ Σ_o Σ_{s'} T(s'|s,a*)·O(o|s',a*)·α*_{o}(s')
 * Γ ← {v_b : b ∈ B}（每点一向量）。
 *
 * 数学保证：Γ₀ = {0}（V₀ ≡ 0 ≤ V*）起，单调 Bellman 算子保证各点值
 * 逐轮不降且恒 ≤ V*（下界）；与 QMDP 上界夹出 [PBVI, QMDP] 值区间。
 * 点集越密逼近越紧（|B| → 稠密 → V' → 精确备份）。
 * @param beliefPoints 信念点集（每个点需为合法信念分布）
 * @param iterations 备份轮数（≥ 1；0 = Γ₀={0}）
 */
export function pbvi(pomdp: POMDP, beliefPoints: readonly (readonly number[])[], iterations: number): PbviResult {
  validatePomdp(pomdp);
  if (!Array.isArray(beliefPoints) || beliefPoints.length === 0) throw new Error('pomdp/pbvi: beliefPoints 需为非空信念数组');
  if (!Number.isInteger(iterations) || iterations < 0) throw new Error(`pomdp/pbvi: iterations ≥ 0 整数（收到 ${iterations}）`);
  const nS = pomdp.states.length;
  const nA = pomdp.actions.length;
  const nO = pomdp.observations.length;
  const gamma = pomdp.gamma;
  const points = beliefPoints.map((b, i) => {
    const copy = [...b];
    validateBelief(pomdp, copy, `pomdp/pbvi.beliefPoints[${i}]`);
    return copy;
  });

  let alphas: number[][] = [];
  let actions: number[] = [];
  const pointValues: number[][] = [];

  for (let it = 0; it < iterations; it += 1) {
    const newAlphas: number[][] = [];
    const newActions: number[] = [];
    const roundValues: number[] = [];
    for (const b of points) {
      let bestVal = Number.NEGATIVE_INFINITY;
      let bestVec: number[] | undefined;
      let bestAction = 0;
      for (let a = 0; a < nA; a += 1) {
        // 即时奖励项
        let imm = 0;
        for (let s = 0; s < nS; s += 1) imm += b[s]! * pomdp.rewards[s]![a]!;
        // 各观测的未归一化后验 τ(b,a,o) 与 max_α α·τ
        const futureVec = new Array<number>(nS).fill(0);
        let future = 0;
        for (let o = 0; o < nO; o += 1) {
          const tau = new Array<number>(nS).fill(0);
          let pObs = 0;
          for (let s2 = 0; s2 < nS; s2 += 1) {
            let forward = 0;
            for (let s = 0; s < nS; s += 1) forward += pomdp.transitions[s]![a]![s2]! * b[s]!;
            tau[s2] = pomdp.O[a]![s2]![o]! * forward;
            pObs += tau[s2]!;
          }
          if (pObs <= 1e-15) continue;
          // max_{α∈Γ} α·τ（Γ 空 = {0}）
          let bestDot = 0;
          let bestAlpha: number[] | null = null;
          for (const alpha of alphas) {
            let dot = 0;
            for (let s2 = 0; s2 < nS; s2 += 1) dot += alpha[s2]! * tau[s2]!;
            if (bestAlpha === null || dot > bestDot) {
              bestDot = dot;
              bestAlpha = alpha;
            }
          }
          future += bestDot;
          if (bestAlpha !== null) {
            for (let s = 0; s < nS; s += 1) {
              let acc = 0;
              for (let s2 = 0; s2 < nS; s2 += 1) acc += pomdp.transitions[s]![a]![s2]! * pomdp.O[a]![s2]![o]! * bestAlpha[s2]!;
              futureVec[s] = futureVec[s]! + acc;
            }
          }
        }
        const val = imm + gamma * future;
        if (bestVec === undefined || val > bestVal) {
          bestVal = val;
          bestAction = a;
          bestVec = pomdp.rewards.map((row, s) => row[a]! + gamma * futureVec[s]!);
        }
      }
      newAlphas.push(bestVec!);
      newActions.push(bestAction);
      roundValues.push(bestVal);
    }
    alphas = newAlphas;
    actions = newActions;
    pointValues.push(roundValues);
  }

  return {
    alphas,
    actions,
    iterations,
    pointValues,
    valueAt: (b: number[]) => beliefValue(alphas, b),
  };
}

// ─────────────────────────── QMDP 上界近似 ───────────────────────────

/** QMDP：底层 MDP 值迭代（γ=1 需正常 MDP——吸收可达；残差字段诚实回报） */
export function qmdp(pomdp: POMDP, tol = 1e-12, maxIter = 100000): { Q: number[][]; V: number[]; iterations: number; residual: number } {
  validatePomdp(pomdp);
  if (!(tol > 0)) throw new Error(`pomdp/qmdp: tol > 0（收到 ${tol}）`);
  const nS = pomdp.states.length;
  const nA = pomdp.actions.length;
  const gamma = pomdp.gamma;
  const stopDelta = gamma >= 1 ? tol : (tol * (1 - gamma)) / gamma;
  let V = new Array<number>(nS).fill(0);
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  while (iterations < maxIter && delta >= stopDelta) {
    iterations += 1;
    delta = 0;
    const next = new Array<number>(nS).fill(0);
    for (let s = 0; s < nS; s += 1) {
      let best = Number.NEGATIVE_INFINITY;
      for (let a = 0; a < nA; a += 1) {
        let acc = pomdp.rewards[s]![a]!;
        for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * pomdp.transitions[s]![a]![s2]! * V[s2]!;
        if (acc > best) best = acc;
      }
      next[s] = best;
      const d = Math.abs(best - V[s]!);
      if (d > delta) delta = d;
    }
    V = next;
  }
  const Q: number[][] = [];
  let residual = 0;
  for (let s = 0; s < nS; s += 1) {
    Q.push([]);
    let best = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < nA; a += 1) {
      let acc = pomdp.rewards[s]![a]!;
      for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * pomdp.transitions[s]![a]![s2]! * V[s2]!;
      Q[s]!.push(acc);
      if (acc > best) best = acc;
    }
    const res = Math.abs(best - V[s]!);
    if (res > residual) residual = res;
  }
  return { Q, V, iterations, residual };
}

/** 信念处的 QMDP 值：max_a Σ_s b(s)Q(s,a)（信息免费的近似口径） */
export function qmdpValueAt(Q: number[][], b: number[]): number {
  if (Q.length === 0) throw new Error('pomdp/qmdpValueAt: Q 非空');
  const nS = Q.length;
  const nA = Q[0]!.length;
  if (b.length !== nS) throw new Error('pomdp/qmdpValueAt: 信念维度与 Q 不匹配');
  let best = Number.NEGATIVE_INFINITY;
  for (let a = 0; a < nA; a += 1) {
    let acc = 0;
    for (let s = 0; s < nS; s += 1) acc += b[s]! * Q[s]![a]!;
    if (acc > best) best = acc;
  }
  return best;
}

// ─────────────────────────── 经典域工厂：Tiger ───────────────────────────

export interface TigerOptions {
  /** 听到正确一侧的概率 ∈ (0.5, 1)，缺省 0.85 */
  hearAccuracy?: number;
  /** 听一次的代价，缺省 −1 */
  listenCost?: number;
  /** 开对门奖励，缺省 +10 */
  openCorrect?: number;
  /** 开错门代价，缺省 −100 */
  openWrong?: number;
  /** 缺省 1（经典无折扣、开门终局口径） */
  gamma?: number;
}

/**
 * 经典两门虎问题（KLC 1998）：状态 [tiger-left, tiger-right, done]，
 * 动作 [listen, open-left, open-right]，观测 [hear-left, hear-right, none]。
 * 听不动虎、代价 −1、听准 p；开门终局（→ done 吸收零奖励）。
 */
export function tigerPomdp(opts: TigerOptions = {}): POMDP {
  const p = opts.hearAccuracy ?? 0.85;
  const listenCost = opts.listenCost ?? -1;
  const openCorrect = opts.openCorrect ?? 10;
  const openWrong = opts.openWrong ?? -100;
  const gamma = opts.gamma ?? 1;
  if (!(p > 0.5 && p < 1)) throw new Error(`pomdp/tigerPomdp: hearAccuracy ∈ (0.5,1)（收到 ${p}）`);
  for (const [k, v] of [
    ['listenCost', listenCost],
    ['openCorrect', openCorrect],
    ['openWrong', openWrong],
  ] as Array<[string, number]>) {
    if (!Number.isFinite(v)) throw new Error(`pomdp/tigerPomdp: ${k} 必须有限`);
  }
  if (!(gamma > 0 && gamma <= 1)) throw new Error(`pomdp/tigerPomdp: gamma ∈ (0,1]（收到 ${gamma}）`);

  const nS = 3;
  const nA = 3;
  const nO = 3;
  const T: number[][][] = Array.from({ length: nS }, () => Array.from({ length: nA }, () => new Array<number>(nS).fill(0)));
  const O: number[][][] = Array.from({ length: nA }, () => Array.from({ length: nS }, () => new Array<number>(nO).fill(0)));
  const R: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(0));
  // T[s][a][s']：listen 不动虎（done 也自环）；开门 → done
  for (let s = 0; s < nS; s += 1) {
    T[s]![0]![s] = 1; // listen
    T[s]![1]![2] = 1; // open-left → done
    T[s]![2]![2] = 1; // open-right → done
  }
  // O[a][s'][o]：listen 下听侧按似然；done 对任意动作发 none；开门后 none
  O[0]![0] = [p, 1 - p, 0];
  O[0]![1] = [1 - p, p, 0];
  O[0]![2] = [0.5, 0.5, 0]; // 不可达（listen 不入 done），给合法行
  O[1]![0] = [0, 0, 1];
  O[1]![1] = [0, 0, 1];
  O[1]![2] = [0, 0, 1];
  O[2]![0] = [0, 0, 1];
  O[2]![1] = [0, 0, 1];
  O[2]![2] = [0, 0, 1];
  // R[s][a]
  R[0]![0] = listenCost;
  R[1]![0] = listenCost;
  R[0]![1] = openWrong; // tiger-left 时开 left
  R[1]![1] = openCorrect;
  R[0]![2] = openCorrect;
  R[1]![2] = openWrong;
  return {
    name: `tiger-p${p}`,
    states: ['tiger-left', 'tiger-right', 'done'],
    actions: ['listen', 'open-left', 'open-right'],
    observations: ['hear-left', 'hear-right', 'none'],
    transitions: T,
    O,
    rewards: R,
    gamma,
  };
}

/* ── 接线建议 ─────────────────────────────────────────────────────────
 *
 * 1. 判断层三数学支柱（与 19.0 / 97.0 组合）:
 *    - 84 给「信念价值」、19.0 最优停止给「何时停等」、97.0 元认知给
 *      「信心校准」——defer/execute/ask-user 在部分可观察下的开销-价值
 *      比较从此有精确口径：ask-user = 一次高精度观测动作，其价值 =
 *      E_o[V(τ(b, ask, o))] − V(b)（beliefUpdate + beliefValue 直接可算）。
 *
 * 2. 探测调度的精确阈值:
 *    - 把健康检查/日志采样/灰度探活建模为「听」动作（O 即检测似然，
 *      由 23.0 稳健统计标定），α-VI 的 greedyActionAt 给出「继续探 vs
 *      立即动」的信念阈值——不是拍脑袋的超时，是 PWLC 值函数的交点。
 *
 * 3. QMDP 上界做快速筛:
 *    - 大状态空间先算 QMDP（|S|×|A| 线性、无 α 爆炸）；其上界与
 *      点基下界的差 < 动作成本时，信息采集不值得精算，直接贪心。
 *
 * 4. 与 83.0 世界模型联动（双件套）:
 *    - 83 的 learnModel 学到的 T̂ 喂给本内核做信念更新（模型→规划）；
 *      本内核的信念轨迹反过来是 83 的经验采集策略（规划→模型）。
 *
 * 5. 挂载边界（零介入承诺）:
 *    - 只读挂载：引擎调用纯函数获取分析结果，内核不发起调度、不写
 *      状态、无 I/O 无时间源无随机源；未挂载时现有路径逐位一致。
 * ────────────────────────────────────────────────────────────────── */
