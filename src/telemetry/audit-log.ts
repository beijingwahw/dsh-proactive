/**
 * audit-log.ts — 遥测审计总线 · 追加式审计账（基础设施之三）
 *
 * 不可变的追加式审计账，带哈希链防篡改：
 * - 条目 {actor, action, target, before?, after?, reason?, ts} + 链字段 {prevHash, hash}
 * - 哈希链：hash_i = Hash(规范串(prevHash_i ‖ 条目 i 核心字段))，首条 prevHash
 *   为创世常量（16 个 '0'）；哈希为自实现非加密哈希（FNV-1a 32 位 +
 *   djb2-xor 32 位双引擎 + 长度混淆，纯 TS，无任何依赖），输出 16 位十六进制
 * - 校验：整链重算 + 前向链接检查；失败时定位第一个断点索引与失配类型
 * - 导出 JSON：确定性字段序（actor, action, target, before, after, reason,
 *   ts, prevHash, hash），对象键递归排序——同一账本两次导出逐位一致；
 *   fromJSON 往返解析并做结构校验
 * - 注入时钟（TelemetryClock，缺省手动时钟从 0 起）：不使用 Date.now
 *
 * R4 二期深化（缺省零漂移——保留策略为 opt-in，未配置时账本行为与
 * 导出逐位不变）：
 * - 双门限保留（AuditLogOptions.retention：maxEntries 容量门限 +
 *   maxAgeMs 时长门限，可并存）：每次追加后裁最旧直至两门限均满足；
 *   裁剪计数可观测（retentionStats()：trimmedEntries / trimOperations /
 *   anchorHash / retainedEntries / oldestRetainedTs）
 * - 链头锚定校验：裁剪后账本首条的 prevHash 指向「最后被裁条目的
 *   hash」（链头锚 anchorHash）而非创世常量；verifyChain(entries,
 *   anchorHash) 以锚为前向起点做整链重算——裁剪不破坏剩余链的完整性
 *   证明，篡改检测照常生效；verify() 自动取本账锚
 * - 导出往返（裁剪账）：exportJSON 在发生过裁剪时附 anchorHash 根字段
 *   （未裁剪不附——零漂移）；parseExport 解析根结构并返回
 *   {version, anchorHash, headHash, entries}，可与 verifyChain 闭环
 *
 * 零依赖：纯内存、零 I/O；入参显式 throw；before/after 在追加时深拷贝并
 * 键序规范化（调用方后续改动原对象不影响账本与导出确定性）。
 */

import { createManualClock, type TelemetryClock } from './event-bus.js';

/** 创世前向哈希（16 个 '0'，与哈希输出等宽） */
export const AUDIT_GENESIS_HASH = '0000000000000000';

// ─────────────────────────── 条目类型 ───────────────────────────

/** 追加参数（核心字段；ts 由注入时钟提供） */
export interface AuditEntryInput {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
}

/** 审计条目：核心字段 + 哈希链字段（字段序即导出序） */
export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
  readonly ts: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** 链校验结果：失败时给出第一个断点索引与失配类型 */
export interface AuditChainVerification {
  readonly valid: boolean;
  /** 已连续校验通过的条数（失败时为断点前的条数） */
  readonly checkedCount: number;
  /** 第一个断点的条目索引（valid 时缺省） */
  readonly breakIndex?: number;
  /** 断点类型：'prevHash'（前向链接断裂）| 'hash'（自身哈希对不上重算值） */
  readonly mismatch?: 'prevHash' | 'hash';
}

/** 双门限保留配置（opt-in：两门限可只给其一；均不给 = 不裁剪） */
export interface AuditRetentionOptions {
  /** 容量门限：账本条数上限（≥1 整数；超出裁最旧） */
  readonly maxEntries?: number;
  /** 时长门限：条目 ts 早于「本次入账 ts − maxAgeMs」即裁（>0 有限数） */
  readonly maxAgeMs?: number;
}

/** 保留策略观测面 */
export interface AuditRetentionStats {
  /** 累计被裁条数 */
  readonly trimmedEntries: number;
  /** 裁剪操作次数（一次 append 触发的多裁计一次） */
  readonly trimOperations: number;
  /** 链头锚：最后被裁条目的 hash（未裁剪 = 创世常量） */
  readonly anchorHash: string;
  /** 当前保留条数 */
  readonly retainedEntries: number;
  /** 当前最老保留条目的 ts（空账为 undefined） */
  readonly oldestRetainedTs: number | undefined;
}

/** 审计账选项 */
export interface AuditLogOptions {
  /** 注入时钟（缺省为 createManualClock(0)——确定性默认） */
  clock?: TelemetryClock;
  /** 双门限保留策略（opt-in；缺省不裁剪——零漂移） */
  retention?: AuditRetentionOptions;
}

// ─────────────────────────── 非加密哈希（纯 TS 自实现） ───────────────────────────

/** 参与哈希的核心字段（固定顺序 = 确定性规范串的一部分） */
export interface AuditHashFields {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
  readonly ts: number;
  readonly prevHash: string;
}

/** 值级规范化序列化：类型可区分、对象键递归排序、数组保序 */
function canonicalValue(value: unknown, path: string): string {
  if (value === undefined) return '~u';
  if (value === null) return '~n';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`audit: 字段 ${path} 含非有限数 ${String(value)}，不可入账`);
    }
    return JSON.stringify(value);
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new TypeError(`audit: 字段 ${path} 含不可序列化类型 ${type}，不可入账`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item, i) => canonicalValue(item, `${path}[${i}]`)).join(',') + ']';
  }
  // 普通对象：键升序（确定性），跳过 undefined 值键（与 JSON.stringify 口径一致）
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalValue(item, `${path}.${key}`)}`);
  }
  return '{' + parts.join(',') + '}';
}

/** 条目核心字段的规范串：版本前缀 + \u0001 分隔 + 固定字段序（分隔符不出现在合法 JSON 字面量中） */
function canonicalEntryString(fields: AuditHashFields): string {
  return [
    'v1',
    JSON.stringify(fields.actor),
    JSON.stringify(fields.action),
    JSON.stringify(fields.target),
    canonicalValue(fields.before, 'before'),
    canonicalValue(fields.after, 'after'),
    fields.reason === undefined ? '~u' : JSON.stringify(fields.reason),
    JSON.stringify(fields.ts),
    JSON.stringify(fields.prevHash),
  ].join('\u0001');
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 自实现非加密哈希：FNV-1a(32) 与 djb2-xor(32) 双引擎 + 长度混淆，
 * 输出 16 位小写十六进制（h1‖h2）。纯整数运算（Math.imul 32 位乘法），
 * 确定性：同输入必同输出。
 */
export function auditHash(fields: AuditHashFields): string {
  const text = canonicalEntryString(fields);
  let h1 = 0x811c9dc5; // FNV-1a 偏移基数
  let h2 = 5381; // djb2 偏移基数
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // FNV-1a：先异或后乘
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    // djb2-xor：乘 33 后异或
    h2 = (Math.imul(h2, 33) ^ code) >>> 0;
  }
  // 长度混淆：两引擎分别与「长度 × 黄金比例素数」异或
  h1 = (h1 ^ Math.imul(text.length, 0x9e3779b1)) >>> 0;
  h2 = (h2 ^ Math.imul(text.length, 0x85ebca6b)) >>> 0;
  return hex8(h1) + hex8(h2);
}

/** 深拷贝 + 键序规范化 + 可序列化校验（追加时对 before/after 调用） */
function canonicalClone(value: unknown, path: string): unknown {
  if (value === undefined || value === null) return value;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`audit: 字段 ${path} 含非有限数 ${String(value)}，不可入账`);
    }
    return value;
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new TypeError(`audit: 字段 ${path} 含不可序列化类型 ${type}，不可入账`);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalClone(item, `${path}[${i}]`));
  }
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    clone[key] = canonicalClone(source[key], `${path}.${key}`);
  }
  return clone;
}

// ─────────────────────────── 审计账 ───────────────────────────

/**
 * AuditLog — 追加式审计账（只增不改；篡改检测靠 verify / verifyChain）。
 */
export class AuditLog {
  private readonly clock: TelemetryClock;
  private readonly maxEntries: number | undefined;
  private readonly maxAgeMs: number | undefined;
  private readonly log: AuditEntry[] = [];
  private anchorHashValue = AUDIT_GENESIS_HASH;
  private trimmedEntries = 0;
  private trimOperations = 0;

  constructor(options: AuditLogOptions = {}) {
    this.clock = options.clock ?? createManualClock(0);
    const retention = options.retention;
    if (retention !== undefined) {
      if (retention === null || typeof retention !== 'object' || Array.isArray(retention)) {
        throw new TypeError(`AuditLog: retention 必须为对象，收到 ${String(retention)}`);
      }
      if (retention.maxEntries !== undefined) {
        if (!Number.isInteger(retention.maxEntries) || retention.maxEntries < 1) {
          throw new RangeError(`AuditLog: retention.maxEntries 必须为 ≥1 的整数，收到 ${String(retention.maxEntries)}`);
        }
        this.maxEntries = retention.maxEntries;
      }
      if (retention.maxAgeMs !== undefined) {
        const age = retention.maxAgeMs;
        if (typeof age !== 'number' || !Number.isFinite(age) || age <= 0) {
          throw new RangeError(`AuditLog: retention.maxAgeMs 必须为 >0 的有限数，收到 ${String(age)}`);
        }
        this.maxAgeMs = age;
      }
    }
  }

  /** 追加条目：ts 取注入时钟；before/after 深拷贝并键序规范化；返回入账条目 */
  append(input: AuditEntryInput): AuditEntry {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError(`append: input 必须为对象，收到 ${String(input)}`);
    }
    assertNonEmptyString(input.actor, 'append(actor)');
    assertNonEmptyString(input.action, 'append(action)');
    assertNonEmptyString(input.target, 'append(target)');
    if (input.reason !== undefined && typeof input.reason !== 'string') {
      throw new TypeError(`append(reason): 必须为 string，收到 ${typeof input.reason}`);
    }
    const ts = this.clock.now();
    if (!Number.isFinite(ts)) {
      throw new TypeError(`append: 时钟返回非有限时间戳 ${String(ts)}`);
    }
    const before = input.before === undefined ? undefined : canonicalClone(input.before, 'before');
    const after = input.after === undefined ? undefined : canonicalClone(input.after, 'after');
    const prevHash = this.log.length === 0 ? this.anchorHashValue : (this.log[this.log.length - 1] as AuditEntry).hash;
    const entry: AuditEntry = {
      actor: input.actor,
      action: input.action,
      target: input.target,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ts,
      prevHash,
      hash: '',
    };
    const hash = auditHash(entry);
    const sealed: AuditEntry = { ...entry, hash };
    this.log.push(sealed);
    this.enforceRetention(ts);
    return sealed;
  }

  /** 条目数 */
  size(): number {
    return this.log.length;
  }

  /** 全部条目（浅拷贝数组；条目本身只读约定） */
  entries(): AuditEntry[] {
    return this.log.slice();
  }

  /** 链头哈希（空账返回链头锚——未裁剪即创世常量） */
  headHash(): string {
    return this.log.length === 0 ? this.anchorHashValue : (this.log[this.log.length - 1] as AuditEntry).hash;
  }

  /** 本账整链校验（以本账链头锚为前向起点——裁剪后仍可校验完整性） */
  verify(): AuditChainVerification {
    return AuditLog.verifyChain(this.log, this.anchorHashValue);
  }

  /** 保留策略观测面（裁剪计数 / 链头锚 / 保留条数与最老 ts） */
  retentionStats(): AuditRetentionStats {
    return {
      trimmedEntries: this.trimmedEntries,
      trimOperations: this.trimOperations,
      anchorHash: this.anchorHashValue,
      retainedEntries: this.log.length,
      oldestRetainedTs: this.log.length === 0 ? undefined : (this.log[0] as AuditEntry).ts,
    };
  }

  /**
   * 确定性 JSON 导出：{version, headHash, entries:[...]}，条目字段序固定；
   * 发生过裁剪时在 version 后附 anchorHash（链头锚定裁剪点）——未裁剪
   * 不附该键（缺省导出逐位不变）。
   */
  exportJSON(): string {
    const entries = this.log.map((entry) => {
      const ordered: Record<string, unknown> = { actor: entry.actor, action: entry.action, target: entry.target };
      if (entry.before !== undefined) ordered.before = entry.before;
      if (entry.after !== undefined) ordered.after = entry.after;
      if (entry.reason !== undefined) ordered.reason = entry.reason;
      ordered.ts = entry.ts;
      ordered.prevHash = entry.prevHash;
      ordered.hash = entry.hash;
      return ordered;
    });
    const root: Record<string, unknown> = { version: 1 };
    if (this.anchorHashValue !== AUDIT_GENESIS_HASH) root.anchorHash = this.anchorHashValue;
    root.headHash = this.headHash();
    root.entries = entries;
    return JSON.stringify(root);
  }

  /**
   * 解析导出的 JSON（结构校验同 fromJSON），返回根结构
   * {version, anchorHash（缺省创世）, headHash（缺省创世）, entries}——
   * 裁剪账可与 verifyChain(entries, anchorHash) 闭环。
   */
  static parseExport(json: string): {
    version: number;
    anchorHash: string;
    headHash: string;
    entries: AuditEntry[];
  } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new TypeError(`parseExport: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('parseExport: 根必须为对象');
    }
    const root = parsed as { version?: unknown; anchorHash?: unknown; headHash?: unknown; entries?: unknown };
    if (root.version !== undefined && root.version !== 1) {
      throw new TypeError(`parseExport: 不支持的 version ${String(root.version)}（本实现导出版本为 1）`);
    }
    if (root.anchorHash !== undefined) assertNonEmptyString(root.anchorHash, 'parseExport(anchorHash)');
    if (root.headHash !== undefined) assertNonEmptyString(root.headHash, 'parseExport(headHash)');
    if (!Array.isArray(root.entries)) {
      throw new TypeError('parseExport: 缺少数组字段 entries');
    }
    return {
      version: 1,
      anchorHash: root.anchorHash === undefined ? AUDIT_GENESIS_HASH : (root.anchorHash as string),
      headHash: root.headHash === undefined ? AUDIT_GENESIS_HASH : (root.headHash as string),
      entries: parseEntries(root.entries),
    };
  }

  /**
   * 解析导出的 JSON：结构校验（必需字段类型、ts 有限、prevHash/hash 为字符串）
   * 并对 before/after 做键序规范化克隆；返回条目数组（可交给 verifyChain 往返校验）。
   */
  static fromJSON(json: string): AuditEntry[] {
    return AuditLog.parseExport(json).entries;
  }

  /**
   * 整链重算校验（纯函数，可对任意条目数组使用——含被篡改的副本）：
   * - 前向链接：entry[0].prevHash 必须等于 anchorHash（缺省创世常量——
   *   未裁剪账即创世口径；裁剪账传「最后被裁条目的 hash」即链头锚），
   *   其后必须等于前一条 hash；
   * - 自身哈希：重算 auditHash 必须逐位等于 entry.hash；
   * - 返回第一个断点索引与失配类型；全链通过返回 {valid:true}。
   */
  static verifyChain(entries: readonly AuditEntry[], anchorHash: string = AUDIT_GENESIS_HASH): AuditChainVerification {
    let expectedPrev = anchorHash;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry === null || typeof entry !== 'object') {
        return { valid: false, checkedCount: i, breakIndex: i, mismatch: 'hash' };
      }
      if (entry.prevHash !== expectedPrev) {
        return { valid: false, checkedCount: i, breakIndex: i, mismatch: 'prevHash' };
      }
      const recomputed = auditHash(entry);
      if (recomputed !== entry.hash) {
        return { valid: false, checkedCount: i, breakIndex: i, mismatch: 'hash' };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true, checkedCount: entries.length };
  }

  // ── 内部：双门限保留 ──

  /**
   * 追加后执行：容量门限（条数超 maxEntries 裁最旧）+ 时长门限
   * （ts < now − maxAgeMs 裁最旧）。每次 append 至多记一次裁剪操作；
   * 每裁一条更新链头锚为该条 hash（锚最终落在最后被裁条目上）。
   */
  private enforceRetention(now: number): void {
    let trimmedThisOp = 0;
    if (this.maxEntries !== undefined) {
      while (this.log.length > this.maxEntries) trimmedThisOp += this.trimOldest();
    }
    if (this.maxAgeMs !== undefined) {
      while (this.log.length > 0 && (this.log[0] as AuditEntry).ts < now - this.maxAgeMs) {
        trimmedThisOp += this.trimOldest();
      }
    }
    if (trimmedThisOp > 0) this.trimOperations += 1;
  }

  /** 裁最旧一条：计数并推进链头锚（= 被裁条目 hash） */
  private trimOldest(): number {
    const removed = this.log.shift();
    if (removed === undefined) return 0;
    this.trimmedEntries += 1;
    this.anchorHashValue = removed.hash;
    return 1;
  }
}

/** 条目数组结构校验 + 键序规范化克隆（fromJSON / parseExport 共用） */
function parseEntries(rawEntries: unknown[]): AuditEntry[] {
  return rawEntries.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`fromJSON: 第 ${index} 条不是对象`);
    }
    const record = raw as Record<string, unknown>;
    assertNonEmptyString(record.actor, `fromJSON(entries[${index}].actor)`);
    assertNonEmptyString(record.action, `fromJSON(entries[${index}].action)`);
    assertNonEmptyString(record.target, `fromJSON(entries[${index}].target)`);
    assertNonEmptyString(record.prevHash, `fromJSON(entries[${index}].prevHash)`);
    assertNonEmptyString(record.hash, `fromJSON(entries[${index}].hash)`);
    if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) {
      throw new TypeError(`fromJSON(entries[${index}].ts): 必须为有限数`);
    }
    if (record.reason !== undefined && typeof record.reason !== 'string') {
      throw new TypeError(`fromJSON(entries[${index}].reason): 必须为 string`);
    }
    const entry: AuditEntry = {
      actor: requireNonEmptyString(record.actor, `fromJSON(entries[${index}].actor)`),
      action: requireNonEmptyString(record.action, `fromJSON(entries[${index}].action)`),
      target: requireNonEmptyString(record.target, `fromJSON(entries[${index}].target)`),
      ...(record.before !== undefined ? { before: canonicalClone(record.before, `entries[${index}].before`) } : {}),
      ...(record.after !== undefined ? { after: canonicalClone(record.after, `entries[${index}].after`) } : {}),
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ts: record.ts,
      prevHash: requireNonEmptyString(record.prevHash, `fromJSON(entries[${index}].prevHash)`),
      hash: requireNonEmptyString(record.hash, `fromJSON(entries[${index}].hash)`),
    };
    return entry;
  });
}

// ─────────────────────────── 内部校验 ───────────────────────────

function assertNonEmptyString(value: unknown, api: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${api}: 必须为非空字符串，收到 ${String(value)}`);
  }
}

function requireNonEmptyString(value: unknown, api: string): string {
  assertNonEmptyString(value, api);
  return value as string;
}
