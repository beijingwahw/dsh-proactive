/**
 * 47.0 无冲突复制内核 —— CRDT 三定律：副本收敛是代数性质
 *
 * 动机: 分布式同步的合并语义若不满足代数定律，副本在网络分区/乱序
 * 送达下发散且不可检测。CRDT（Shapiro et al. 2011）把「收敛」从协议
 * 希望变成**合并算子的代数性质**:
 *
 *   强最终一致性定理: 合并 ⋃ 满足交换/结合/幂等三律（join-semilattice）
 *   ⟹ 任意乱序/重复送达的消息流之后，所有活跃副本状态相等——
 *   不需要共识、不需要协调、不需要可信信道。
 *
 *   - G-Counter: 每节点只加自己的分量，合并 = 逐分量 max
 *   - OR-Set (add-win): 元素带唯一标签，add 打标签 / remove 摘标签，
 *     合并 = 标签并集；并发 add+remove 中 add 胜（语义选择，非歧义）
 *   - LWW-Register: 时间戳偏序 + 节点 id 平局仲裁（全序保证合并唯一）
 *   - 2P-Set (remove-win，R5): 两相集——add 集只增、tombstone 集只增，
 *     元素一旦移除永不复活；与 OR-Set 的 add-win 互为对偶语义选择
 *   - Delta-G-Counter (R5): 增量状态传播——只发增量不发全量，
 *     增量合并闭包仍为 join-semilattice（收敛定理不动），
 *     通信量从 O(节点数) 每条消息降到 O(活跃分量)
 *
 *   验证锚点: 随机操作流的任意置换应用 → 状态逐位相等（收敛定理的
 *   有限样本验证）；三律逐位检查；delta 传播 ≡ 全量传播（等价证明）。
 *
 * 零漂移: 纯数据结构内核（引擎按需使用），未挂载零介入。
 */

/** G-Counter（增长计数器；merge = 逐分量 max） */
export class GCounter {
  private counts = new Map<string, number>();
  /**
   * 未收割增量（delta-state CRDT，R5 性能进化）：记录**自上次收割以来
   * 被触碰分量的最新状态片段**（绝对分量值，非增量差——delta-state 语义
   * 下「增量」= 部分状态，合并仍 = 逐分量 max，与全量合并代数等价；
   * Almeida et al. 2018 delta-CRDT 口径）。
   */
  private pending = new Map<string, number>();

  increment(nodeId: string, by = 1): void {
    const delta = Math.max(0, Math.floor(by));
    this.counts.set(nodeId, (this.counts.get(nodeId) ?? 0) + delta);
    if (delta > 0) this.pending.set(nodeId, this.counts.get(nodeId)!);
  }

  value(): number {
    let sum = 0;
    for (const v of this.counts.values()) sum += v;
    return sum;
  }

  state(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  merge(other: GCounter): void {
    for (const [k, v] of other.counts) {
      this.counts.set(k, Math.max(this.counts.get(k) ?? 0, v));
    }
  }

  /**
   * 增量传播（R5）：自上次收割以来被触碰分量的状态片段（空对象 = 无
   * 增量可发）。语义: 对等端 mergeDelta(d) 与 merge(本端全量) 终态逐位
   * 相同——只发触碰分量（通常 1 条）不发全量 state()（全部活跃分量）。
   */
  drainDelta(): Record<string, number> {
    const delta = Object.fromEntries(this.pending);
    this.pending.clear();
    return delta;
  }

  /** 增量合并（R5）：逐分量 max（与全量 merge 同一代数闭包） */
  mergeDelta(delta: Record<string, number>): void {
    for (const [k, v] of Object.entries(delta)) {
      const num = Math.max(0, Math.floor(v));
      if (num > (this.counts.get(k) ?? 0)) this.counts.set(k, num);
    }
  }

  clone(): GCounter {
    const c = new GCounter();
    c.merge(this);
    return c;
  }
}

/**
 * 2P-Set（两相集；R5 数学进化——remove-win 语义的形式化）。
 *
 * grow 集只增 + tombstone 集只增；has(e) = grow(e) ∧ ¬tomb(e)。
 * 与 OR-Set 的 add-win 互为对偶语义选择:
 *   OR-Set: remove 只能摘掉**见过的**标签——并发 add 胜（适合购物车：
 *   你不知道别人正往里加什么）；
 *   2P-Set: tombstone 一旦落下永不撤销——remove 胜（适合黑名单/撤回：
 *   「删了就是删了」，永不被迟到的 add 复活）。
 * 合并 = 两集分别并集 ⟹ join-semilattice ⟹ 三律成立 ⟹ 收敛定理适用。
 */
export class TwoPhaseSet {
  private added = new Set<string>();
  private tombed = new Set<string>();

  add(element: string): void {
    this.added.add(element);
  }

  /** 移除（打 tombstone——对未见过的元素同样生效：remove 永胜） */
  remove(element: string): void {
    this.tombed.add(element);
  }

  has(element: string): boolean {
    return this.added.has(element) && !this.tombed.has(element);
  }

  /** 活跃元素（add 过且未 tomb） */
  elements(): string[] {
    return [...this.added].filter((e) => !this.tombed.has(e));
  }

  /** 合并 = 两集分别并（交换/结合/幂等三律的逐位检查锚点） */
  merge(other: TwoPhaseSet): void {
    for (const e of other.added) this.added.add(e);
    for (const e of other.tombed) this.tombed.add(e);
  }

  /** 状态快照（可序列化口径） */
  state(): { added: string[]; tombed: string[] } {
    return { added: [...this.added], tombed: [...this.tombed] };
  }

  clone(): TwoPhaseSet {
    const s = new TwoPhaseSet();
    s.merge(this);
    return s;
  }
}

/** OR-Set（add-win 观察者集；标签唯一 → 并发 add 胜 remove） */
export class ORSet {
  private added = new Map<string, Set<string>>();
  private removed = new Map<string, Set<string>>();

  add(element: string, tag?: string): void {
    const t = tag ?? `${element}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const bucket = this.added.get(element) ?? new Set<string>();
    bucket.add(t);
    this.added.set(element, bucket);
  }

  remove(element: string): void {
    const tags = this.added.get(element);
    if (!tags) return;
    this.removed.set(element, new Set([...(this.removed.get(element) ?? []), ...tags]));
  }

  has(element: string): boolean {
    const live = [...(this.added.get(element) ?? [])].filter((t) => !(this.removed.get(element) ?? new Set()).has(t));
    return live.length > 0;
  }

  elements(): string[] {
    return [...this.added.keys()].filter((e) => this.has(e));
  }

  merge(other: ORSet): void {
    for (const [e, tags] of other.added) {
      const bucket = this.added.get(e) ?? new Set<string>();
      for (const t of tags) bucket.add(t);
      this.added.set(e, bucket);
    }
    for (const [e, tags] of other.removed) {
      const bucket = this.removed.get(e) ?? new Set<string>();
      for (const t of tags) bucket.add(t);
      this.removed.set(e, bucket);
    }
  }

  clone(): ORSet {
    const s = new ORSet();
    s.merge(this);
    return s;
  }
}

/** LWW-Register（时间戳 + 节点 id 仲裁的全序最后写胜） */
export class LWWRegister<T> {
  private value?: T;
  private stamp = -1;
  private writer = '';

  constructor(private readonly nodeId: string) {}

  set(value: T, stamp: number): void {
    if (stamp < this.stamp || (stamp === this.stamp && this.writer >= this.nodeId)) return;
    this.value = value;
    this.stamp = stamp;
    this.writer = this.nodeId;
  }

  get(): T | undefined {
    return this.value;
  }

  state(): { value?: T; stamp: number; writer: string } {
    return { value: this.value, stamp: this.stamp, writer: this.writer };
  }

  merge(other: { value?: T; stamp: number; writer: string }): void {
    if (other.stamp < this.stamp) return;
    if (other.stamp === this.stamp && other.writer <= this.writer) return;
    this.value = other.value;
    this.stamp = other.stamp;
    this.writer = other.writer;
  }
}

/**
 * 收敛审计（验证锚点）: 两副本各自应用同批操作的任意置换，再互相
 * 合并（含重复合并）——三律成立 ⟹ 状态逐位相等（强最终一致性的
 * 有限样本验证）。返回最大状态偏差（应恒 0）。
 */
export function crdtConvergenceAudit(
  ops: ReadonlyArray<{ node: 'a' | 'b'; kind: 'inc'; by: number } | { node: 'a' | 'b'; kind: 'add' | 'remove'; element: string }>,
  permutation: ReadonlyArray<number>,
): { counterDelta: number; setSymmetricDiff: number } {
  const ca = new GCounter();
  const cb = new GCounter();
  const sa = new ORSet();
  const sb = new ORSet();
  for (const idx of permutation) {
    const op = ops[idx];
    if (!op) continue;
    const [cTarget, sTarget] = op.node === 'a' ? [ca, sa] : [cb, sb];
    if (op.kind === 'inc') cTarget.increment(op.node, op.by);
    else if (op.kind === 'add') sTarget.add(op.element, `${op.node}:${idx}`);
    else sTarget.remove(op.element);
  }
  // 双向 gossip 两次（幂等性 + 交换性的联合考验）
  const ca2 = ca.clone();
  const cb2 = cb.clone();
  ca.merge(cb2);
  cb.merge(ca2);
  const sa2 = sa.clone();
  const sb2 = sb.clone();
  sa.merge(sb2);
  sb.merge(sa2);
  const counterDelta = Math.abs(ca.value() - cb.value());
  const a = new Set(sa.elements());
  const b = new Set(sb.elements());
  let setSymmetricDiff = 0;
  for (const e of a) if (!b.has(e)) setSymmetricDiff += 1;
  for (const e of b) if (!a.has(e)) setSymmetricDiff += 1;
  return { counterDelta, setSymmetricDiff };
}
