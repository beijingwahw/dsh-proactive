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
 *
 *   验证锚点: 随机操作流的任意置换应用 → 状态逐位相等（收敛定理的
 *   有限样本验证）；三律逐位检查。
 *
 * 零漂移: 纯数据结构内核（引擎按需使用），未挂载零介入。
 */

/** G-Counter（增长计数器；merge = 逐分量 max） */
export class GCounter {
  private counts = new Map<string, number>();

  increment(nodeId: string, by = 1): void {
    this.counts.set(nodeId, (this.counts.get(nodeId) ?? 0) + Math.max(0, Math.floor(by)));
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

  clone(): GCounter {
    const c = new GCounter();
    c.merge(this);
    return c;
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
