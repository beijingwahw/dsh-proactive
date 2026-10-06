/**
 * migration-tool.ts — 记忆迁移工具（能力层，依赖 long-term-memory）
 *
 * 职责：
 * - 将记忆库导出为自包含的迁移包（MigrationPackage），支持文件落盘
 * - 将迁移包导入目标记忆库，支持四种冲突合并策略
 * - dryRun 预演冲突与统计，不产生任何写入
 * - 跨租户记忆迁移（源记忆库 → 目标记忆库）
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 完整性保护：迁移包携带 data 段的 SHA-256 校验和，导入前强制校验，
 *    防止传输/存储过程中的静默损坏与人为篡改
 * 2. 语义化冲突检测：pattern 按 fingerprint、model-profile 按 id、
 *    feedback 按 id 建立冲突键，冲突双方数据完整保留在 MigrationConflict 中供审计
 * 3. newer-wins 策略基于 lastSeenAt/timestamp 做时间戳仲裁，而非盲目覆盖
 * 4. merge 策略对任务模式做深度合并（成功方案并集 + 失败记录并集 + 统计重算），
 *    而非简单二选一，最大化保留双方经验
 * 5. 全程错误隔离：单条记录导入失败不中断整体迁移，错误收集进 MigrationReport.errors
 *
 * 4.0 修复（数据丢失）：语义记忆与程序记忆此前完全不参与导出/导入——跨实例/
 * 跨租户迁移后蒸馏出的规律与 if-then 规则全部丢失。现补全：
 * - 导出包含 semanticMemories / proceduralMemories（可分别关闭）
 * - 导入按 id 建冲突键，四种策略仲裁；merge 复用记忆库自身的
 *   证据合并语义（支撑累加 + 证据继承），newer-wins 按 distilledAt/lastAppliedAt 仲裁
 * - dryRun 同步预演语义/程序记忆的冲突与新增量
 *
 * 第三轮升级：dry-run 差异报告 + 迁移往返一致性校验
 * - diff()：本地库 vs 迁移包的 增/删/改/不变 四态计数（removed = 本地多出的键
 *   ——源库已删而本地残留的清单；changed 用规范化序列化判定，键序无关），
 *   dryRun 返回值直接携带 diff（旧字段原样保留）
 * - verifyRoundTrip()：source →（export → import）→ target 后五类记录逐条
 *   规范化比对，lossless + mismatches 明细——迁移「不丢东西」的机械判据
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryError } from '../errors.js';
import type {
  LongTermMemory,
  TaskPatternMemory,
  ModelLongTermProfile,
  DecisionFeedback,
  SemanticMemory,
  ProceduralMemory,
  MemoryStore,
} from './long-term-memory.js';
import type { TenantConfig } from '../tenant/tenant-manager.js';

/** 迁移冲突中可保留的记录版本（按冲突类型判别） */
export type MigrationRecordVersion = TaskPatternMemory | ModelLongTermProfile | DecisionFeedback | SemanticMemory | ProceduralMemory;

/** 迁移包（自包含、可校验、可审计） */
export interface MigrationPackage {
  version: number;
  exportedAt: number;
  source: {
    instanceId: string;
    instanceName?: string;
    pluginVersion: string;
  };
  scope: {
    includePatterns: boolean;
    includeModelProfiles: boolean;
    includeFeedback: boolean;
    includeSemanticMemories: boolean;
    includeProceduralMemories: boolean;
    includeGlobalStats: boolean;
    tenantFilter?: string[];
  };
  /** data 段 JSON 序列化后的 SHA-256（hex），导入前强制校验 */
  checksum: string;
  data: {
    taskPatterns?: TaskPatternMemory[];
    modelProfiles?: ModelLongTermProfile[];
    decisionFeedback?: DecisionFeedback[];
    /** 4.0：语义记忆（跨任务规律）——此前缺失导致迁移丢数据 */
    semanticMemories?: SemanticMemory[];
    /** 4.0：程序记忆（if-then 规则）——此前缺失导致迁移丢数据 */
    proceduralMemories?: ProceduralMemory[];
    globalStats?: MemoryStore['globalStats'];
    tenants?: TenantConfig[];
  };
}

/** 冲突合并策略 */
export type MergeStrategy = 'overwrite' | 'merge' | 'skip' | 'newer-wins';

/** 迁移冲突记录（保留双方数据供审计） */
export interface MigrationConflict {
  type: 'pattern' | 'model-profile' | 'feedback' | 'semantic' | 'procedural';
  key: string;
  localVersion: MigrationRecordVersion;
  remoteVersion: MigrationRecordVersion;
  resolution?: MergeStrategy;
}

/** 迁移结果报告 */
export interface MigrationReport {
  success: boolean;
  strategy: MergeStrategy;
  imported: {
    patterns: number;
    modelProfiles: number;
    feedback: number;
    semantic: number;
    procedural: number;
  };
  skipped: number;
  conflicts: MigrationConflict[];
  errors: string[];
  duration: number;
}

/** 导出选项 */
export interface ExportOptions {
  includePatterns?: boolean;
  includeModelProfiles?: boolean;
  includeFeedback?: boolean;
  includeSemanticMemories?: boolean;
  includeProceduralMemories?: boolean;
  includeGlobalStats?: boolean;
  tenantFilter?: string[];
  instanceName?: string;
}

/**
 * 差异四态计数（第三轮升级：dry-run 差异报告的原子口径）
 * - added：包有本地无（导入将新增）
 * - removed：本地有包无（导入后本地将多出——提示源库可能已删）
 * - changed：同键两侧内容深度不等（将按策略仲裁）
 * - unchanged：同键内容深度相等（任何策略下都无操作必要）
 */
export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/** 迁移差异报告（增/删/改计数 + 每类抽样键，dry-run 的人类可读底账） */
export interface MigrationDiffReport {
  patterns: DiffSummary;
  modelProfiles: DiffSummary;
  feedback: DiffSummary;
  semantic: DiffSummary;
  procedural: DiffSummary;
  /** 五类合计 */
  total: DiffSummary;
  /** 每类抽 3 个键（审计定位用，非全量清单） */
  samples: {
    added: string[];
    removed: string[];
    changed: string[];
  };
}

/**
 * 往返一致性报告（第三轮升级：导出 → 导入后源/目标逐条比对）
 *
 * 迁移「不丢东西」的机械判据：五类记录的键集合完全一致 + 每条记录
 * 的规范化序列化（canonical stringify，键序无关）完全相等。
 * lossless=false 时 mismatches 逐条列出差异（键缺失 / 内容漂移）。
 */
export interface RoundTripReport {
  lossless: boolean;
  checked: {
    patterns: number;
    modelProfiles: number;
    feedback: number;
    semantic: number;
    procedural: number;
  };
  mismatches: string[];
}

/** 迁移包格式版本 */
const PACKAGE_VERSION = 1;
/** 插件版本（与 package.json 对齐） */
const PLUGIN_VERSION = '0.1.0';

/**
 * 记忆迁移工具
 *
 * 被 index.ts 的 memory_migration Tool 调用（export/import/dry-run/migrate-tenant）。
 */
export class MigrationTool {
  private instanceId: string;

  /**
   * @param instanceId 当前实例标识（写入迁移包 source），缺省自动生成
   */
  constructor(instanceId?: string) {
    this.instanceId = instanceId ?? `instance-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * 从记忆库实例导出迁移包
   * @param memory 源记忆库
   * @param options 导出范围选项（缺省全量导出）
   */
  exportFromMemory(memory: LongTermMemory, options?: ExportOptions): MigrationPackage {
    const opts: Required<Omit<ExportOptions, 'tenantFilter' | 'instanceName'>> & Pick<ExportOptions, 'tenantFilter' | 'instanceName'> = {
      includePatterns: options?.includePatterns ?? true,
      includeModelProfiles: options?.includeModelProfiles ?? true,
      includeFeedback: options?.includeFeedback ?? true,
      includeSemanticMemories: options?.includeSemanticMemories ?? true,
      includeProceduralMemories: options?.includeProceduralMemories ?? true,
      includeGlobalStats: options?.includeGlobalStats ?? true,
      tenantFilter: options?.tenantFilter,
      instanceName: options?.instanceName,
    };

    const data: MigrationPackage['data'] = {};
    if (opts.includePatterns) data.taskPatterns = memory.getAllTaskPatterns();
    if (opts.includeModelProfiles) data.modelProfiles = memory.getAllModelProfiles();
    if (opts.includeFeedback) data.decisionFeedback = memory.getAllDecisionFeedback();
    if (opts.includeSemanticMemories) data.semanticMemories = memory.getAllSemanticMemories();
    if (opts.includeProceduralMemories) data.proceduralMemories = memory.getAllProceduralMemories();
    if (opts.includeGlobalStats) data.globalStats = memory.getGlobalStats();

    return this.buildPackage(data, opts);
  }

  /**
   * 从磁盘文件读取迁移包（含校验和验证）
   * @param filePath 迁移包文件路径
   * @throws MemoryError 文件不存在 / JSON 非法 / 校验和不匹配
   */
  exportFromFile(filePath: string): MigrationPackage {
    if (!fs.existsSync(filePath)) {
      throw new MemoryError(`迁移包文件不存在: ${filePath}`);
    }
    let pkg: MigrationPackage;
    try {
      pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MigrationPackage;
    } catch (err) {
      throw new MemoryError(`迁移包解析失败: ${filePath}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    this.verifyChecksum(pkg);
    return pkg;
  }

  /**
   * 导出迁移包并写入文件
   * @param memory 源记忆库
   * @param outputPath 输出路径
   * @param options 导出范围选项
   */
  exportToFile(memory: LongTermMemory, outputPath: string, options?: ExportOptions): void {
    const pkg = this.exportFromMemory(memory, options);
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${outputPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2), 'utf-8');
    fs.renameSync(tmp, outputPath);
  }

  /**
   * 将迁移包导入目标记忆库
   * @param memory 目标记忆库
   * @param pkg 迁移包
   * @param strategy 冲突合并策略，默认 merge
   */
  importToMemory(memory: LongTermMemory, pkg: MigrationPackage, strategy: MergeStrategy = 'merge'): MigrationReport {
    const startedAt = Date.now();
    const report: MigrationReport = {
      success: true,
      strategy,
      imported: { patterns: 0, modelProfiles: 0, feedback: 0, semantic: 0, procedural: 0 },
      skipped: 0,
      conflicts: [],
      errors: [],
      duration: 0,
    };

    try {
      // 1. 校验和验证（防篡改 / 防损坏）
      this.verifyChecksum(pkg);

      // 2. 导入任务模式（本地键索引一次构建、写入后同步维护——upsertPattern
      //    按指纹存储传入对象本身，Map 镜像与全量 find 结果逐位一致；
      //    原实现每条 remote 全量扫描 + 全数组拷贝，O(n·m) 且分配抖动）
      const localPatternById = new Map(memory.getAllTaskPatterns().map((p) => [p.fingerprint, p]));
      for (const remote of pkg.data.taskPatterns ?? []) {
        try {
          const local = localPatternById.get(remote.fingerprint);
          if (!local) {
            memory.upsertPattern(remote);
            localPatternById.set(remote.fingerprint, remote);
            report.imported.patterns += 1;
            continue;
          }
          // 冲突处理
          const conflict: MigrationConflict = {
            type: 'pattern',
            key: remote.fingerprint,
            localVersion: local,
            remoteVersion: remote,
            resolution: strategy,
          };
          report.conflicts.push(conflict);
          const winner = this.resolvePatternConflict(local, remote, strategy);
          if (winner === null) {
            report.skipped += 1;
          } else {
            memory.upsertPattern(winner);
            localPatternById.set(winner.fingerprint, winner);
            report.imported.patterns += 1;
          }
        } catch (err) {
          report.errors.push(`pattern[${remote.fingerprint}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 3. 导入模型画像
      for (const remote of pkg.data.modelProfiles ?? []) {
        try {
          const local = memory.getModelProfile(remote.id);
          if (!local) {
            memory.upsertModelProfile(remote);
            report.imported.modelProfiles += 1;
            continue;
          }
          const conflict: MigrationConflict = {
            type: 'model-profile',
            key: remote.id,
            localVersion: local,
            remoteVersion: remote,
            resolution: strategy,
          };
          report.conflicts.push(conflict);
          const winner = this.resolveProfileConflict(local, remote, strategy);
          if (winner === null) {
            report.skipped += 1;
          } else {
            memory.upsertModelProfile(winner);
            report.imported.modelProfiles += 1;
          }
        } catch (err) {
          report.errors.push(`model-profile[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 4. 导入语义记忆（4.0 补全：按 id 冲突键；merge 复用记忆库证据合并语义）
      //    第四轮：新条目直插绕过冲突门槛（bypassConflictGate）——迁移是传输
      //    不是裁决：包内条目（含仲裁降级的历史观点）在上游已裁决，导入侧
      //    再走 1.5 倍门槛会把历史观点当「矛盾新证据」丢弃，破坏无损迁移。
      for (const remote of pkg.data.semanticMemories ?? []) {
        try {
          const local = memory.getAllSemanticMemories().find((m) => m.id === remote.id);
          if (!local) {
            memory.upsertSemanticMemory(remote, { bypassConflictGate: true });
            report.imported.semantic += 1;
            continue;
          }
          const conflict: MigrationConflict = {
            type: 'semantic',
            key: remote.id,
            localVersion: local,
            remoteVersion: remote,
            resolution: strategy,
          };
          report.conflicts.push(conflict);
          const winner = this.resolveSemanticConflict(local, remote, strategy);
          if (winner === null) {
            report.skipped += 1;
          } else {
            memory.upsertSemanticMemory(winner);
            report.imported.semantic += 1;
          }
        } catch (err) {
          report.errors.push(`semantic[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 5. 导入程序记忆（4.0 补全：按 id 冲突键；第四轮 bypassConflictGate 同上）
      for (const remote of pkg.data.proceduralMemories ?? []) {
        try {
          const local = memory.getAllProceduralMemories().find((p) => p.id === remote.id);
          if (!local) {
            memory.upsertProceduralMemory(remote, { bypassConflictGate: true });
            report.imported.procedural += 1;
            continue;
          }
          const conflict: MigrationConflict = {
            type: 'procedural',
            key: remote.id,
            localVersion: local,
            remoteVersion: remote,
            resolution: strategy,
          };
          report.conflicts.push(conflict);
          const winner = this.resolveProceduralConflict(local, remote, strategy);
          if (winner === null) {
            report.skipped += 1;
          } else {
            memory.upsertProceduralMemory(winner);
            report.imported.procedural += 1;
          }
        } catch (err) {
          report.errors.push(`procedural[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 6. 导入决策反馈（按 id 去重，天然幂等）
      for (const remote of pkg.data.decisionFeedback ?? []) {
        try {
          const written = memory.appendFeedback(remote);
          if (written) {
            report.imported.feedback += 1;
          } else {
            report.skipped += 1;
          }
        } catch (err) {
          report.errors.push(`feedback[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 7. 合并全局统计（仅 merge / overwrite 策略下累加）
      if (pkg.data.globalStats && (strategy === 'merge' || strategy === 'overwrite')) {
        memory.mergeGlobalStats(pkg.data.globalStats);
      }

      report.success = report.errors.length === 0;
    } catch (err) {
      report.success = false;
      report.errors.push(err instanceof Error ? err.message : String(err));
    }

    report.duration = Date.now() - startedAt;
    return report;
  }

  /**
   * 从文件读取迁移包并导入
   * @param memory 目标记忆库
   * @param filePath 迁移包文件路径
   * @param strategy 冲突合并策略，默认 merge
   */
  importFromFile(memory: LongTermMemory, filePath: string, strategy: MergeStrategy = 'merge'): MigrationReport {
    const pkg = this.exportFromFile(filePath);
    return this.importToMemory(memory, pkg, strategy);
  }

  /**
   * 预演导入：检测冲突与统计，不产生任何写入
   * @param memory 目标记忆库
   * @param pkg 迁移包
   */
  dryRun(memory: LongTermMemory, pkg: MigrationPackage): { conflicts: MigrationConflict[]; summary: Record<string, number>; diff: MigrationDiffReport } {
    this.verifyChecksum(pkg);
    const conflicts: MigrationConflict[] = [];
    let newPatterns = 0;
    let newProfiles = 0;
    let newFeedback = 0;
    let newSemantic = 0;
    let newProcedural = 0;
    let duplicates = 0;

    const localPatterns = new Map(memory.getAllTaskPatterns().map((p) => [p.fingerprint, p]));
    const localFeedbackIds = new Set(memory.getAllDecisionFeedback().map((f) => f.id));
    const localSemanticById = new Map(memory.getAllSemanticMemories().map((m) => [m.id, m]));
    const localProceduralById = new Map(memory.getAllProceduralMemories().map((p) => [p.id, p]));

    for (const remote of pkg.data.taskPatterns ?? []) {
      const local = localPatterns.get(remote.fingerprint);
      if (local) {
        conflicts.push({ type: 'pattern', key: remote.fingerprint, localVersion: local, remoteVersion: remote });
      } else {
        newPatterns += 1;
      }
    }
    for (const remote of pkg.data.modelProfiles ?? []) {
      const local = memory.getModelProfile(remote.id);
      if (local) {
        conflicts.push({ type: 'model-profile', key: remote.id, localVersion: local, remoteVersion: remote });
      } else {
        newProfiles += 1;
      }
    }
    for (const remote of pkg.data.decisionFeedback ?? []) {
      if (localFeedbackIds.has(remote.id)) {
        duplicates += 1;
      } else {
        newFeedback += 1;
      }
    }
    for (const remote of pkg.data.semanticMemories ?? []) {
      const local = localSemanticById.get(remote.id);
      if (local) {
        conflicts.push({ type: 'semantic', key: remote.id, localVersion: local, remoteVersion: remote });
      } else {
        newSemantic += 1;
      }
    }
    for (const remote of pkg.data.proceduralMemories ?? []) {
      const local = localProceduralById.get(remote.id);
      if (local) {
        conflicts.push({ type: 'procedural', key: remote.id, localVersion: local, remoteVersion: remote });
      } else {
        newProcedural += 1;
      }
    }

    return {
      conflicts,
      summary: {
        newPatterns,
        newProfiles,
        newFeedback,
        newSemantic,
        newProcedural,
        conflicts: conflicts.length,
        duplicates,
        totalIncoming:
          (pkg.data.taskPatterns?.length ?? 0) +
          (pkg.data.modelProfiles?.length ?? 0) +
          (pkg.data.decisionFeedback?.length ?? 0) +
          (pkg.data.semanticMemories?.length ?? 0) +
          (pkg.data.proceduralMemories?.length ?? 0),
      },
      // 第三轮升级：dry-run 直接携带增/删/改差异报告（与逐条冲突明细互补的计数口径）
      diff: this.diff(memory, pkg),
    };
  }

  /**
   * 差异报告（第三轮升级）：本地库 vs 迁移包的增/删/改/不变计数。
   *
   * 与 dryRun 的冲突检测互补：冲突只看「同键」，diff 还看「本地多出的键」
   * （removed——源库已删而本地残留）与「内容深度等价」（unchanged——任何
   * 策略下都无需操作，可从迁移热点中排除）。「改」的判定用规范化序列化
   * （键序无关），键同内容异即 changed。
   */
  diff(memory: LongTermMemory, pkg: MigrationPackage): MigrationDiffReport {
    const samples = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
    const note = (kind: 'added' | 'removed' | 'changed', label: string, key: string): void => {
      // 五类各留最多 3 个样本键（每类 9 封顶即整体安全上限）
      if (samples[kind].filter((s) => s.startsWith(`${label}[`)).length < 3) samples[kind].push(`${label}[${key}]`);
    };
    const diffSection = <T extends object>(label: string, localEntries: T[], remoteEntries: T[], keyOf: (item: T) => string): DiffSummary => {
      const summary: DiffSummary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
      const localByKey = new Map(localEntries.map((e) => [keyOf(e), e]));
      const remoteByKey = new Map(remoteEntries.map((e) => [keyOf(e), e]));
      for (const [key, remote] of remoteByKey) {
        const local = localByKey.get(key);
        if (!local) {
          summary.added += 1;
          note('added', label, key);
        } else if (this.canonicalStringify(local) !== this.canonicalStringify(remote)) {
          summary.changed += 1;
          note('changed', label, key);
        } else {
          summary.unchanged += 1;
        }
      }
      for (const key of localByKey.keys()) {
        if (!remoteByKey.has(key)) {
          summary.removed += 1;
          note('removed', label, key);
        }
      }
      return summary;
    };

    const patterns = diffSection('pattern', memory.getAllTaskPatterns(), pkg.data.taskPatterns ?? [], (p) => p.fingerprint);
    const modelProfiles = diffSection('model-profile', memory.getAllModelProfiles(), pkg.data.modelProfiles ?? [], (p) => p.id);
    const feedback = diffSection('feedback', memory.getAllDecisionFeedback(), pkg.data.decisionFeedback ?? [], (f) => f.id);
    const semantic = diffSection('semantic', memory.getAllSemanticMemories(), pkg.data.semanticMemories ?? [], (m) => m.id);
    const procedural = diffSection('procedural', memory.getAllProceduralMemories(), pkg.data.proceduralMemories ?? [], (p) => p.id);
    const sum = (sections: DiffSummary[]): DiffSummary => ({
      added: sections.reduce((s, x) => s + x.added, 0),
      removed: sections.reduce((s, x) => s + x.removed, 0),
      changed: sections.reduce((s, x) => s + x.changed, 0),
      unchanged: sections.reduce((s, x) => s + x.unchanged, 0),
    });

    return {
      patterns,
      modelProfiles,
      feedback,
      semantic,
      procedural,
      total: sum([patterns, modelProfiles, feedback, semantic, procedural]),
      samples,
    };
  }

  /**
   * 迁移往返一致性校验（第三轮升级）：source →（export → import）→ target 后，
   * 机械证明「没丢东西、没改东西」——五类记录键集合一致 + 每条规范化序列化相等。
   *
   * 典型用法（无损口径）：export 用 includeGlobalStats: false（globalStats 的
   * 导入是合并累加语义，往返必然翻倍，不参与无损判定）。
   *
   * @param source 源记忆库（导出方）
   * @param target 目标记忆库（导入方）
   * @param options.compareGlobalStats 额外比对 globalStats（默认 false，见上）
   */
  verifyRoundTrip(
    source: LongTermMemory,
    target: LongTermMemory,
    options?: { compareGlobalStats?: boolean },
  ): RoundTripReport {
    const mismatches: string[] = [];
    const compare = (
      label: string,
      localList: Array<{ key: string; canonical: string }>,
      remoteList: Array<{ key: string; canonical: string }>,
    ): number => {
      const localMap = new Map(localList.map((e) => [e.key, e.canonical]));
      const remoteMap = new Map(remoteList.map((e) => [e.key, e.canonical]));
      for (const [key, canonical] of localMap) {
        if (!remoteMap.has(key)) mismatches.push(`${label}[${key}]: 目标库缺失`);
        else if (remoteMap.get(key) !== canonical) mismatches.push(`${label}[${key}]: 内容漂移`);
      }
      for (const key of remoteMap.keys()) {
        if (!localMap.has(key)) mismatches.push(`${label}[${key}]: 目标库多出`);
      }
      return localList.length;
    };

    const asPairs = <T extends object>(items: T[], key: (item: T) => string): Array<{ key: string; canonical: string }> =>
      items.map((item) => ({ key: key(item), canonical: this.canonicalStringify(item) }));

    const checked = {
      patterns: compare(
        'pattern',
        asPairs(source.getAllTaskPatterns(), (p) => p.fingerprint),
        asPairs(target.getAllTaskPatterns(), (p) => p.fingerprint),
      ),
      modelProfiles: compare(
        'model-profile',
        asPairs(source.getAllModelProfiles(), (p) => p.id),
        asPairs(target.getAllModelProfiles(), (p) => p.id),
      ),
      feedback: compare(
        'feedback',
        asPairs(source.getAllDecisionFeedback(), (f) => f.id),
        asPairs(target.getAllDecisionFeedback(), (f) => f.id),
      ),
      semantic: compare(
        'semantic',
        asPairs(source.getAllSemanticMemories(), (m) => m.id),
        asPairs(target.getAllSemanticMemories(), (m) => m.id),
      ),
      procedural: compare(
        'procedural',
        asPairs(source.getAllProceduralMemories(), (p) => p.id),
        asPairs(target.getAllProceduralMemories(), (p) => p.id),
      ),
    };

    if (options?.compareGlobalStats) {
      const a = this.canonicalStringify(source.getGlobalStats());
      const b = this.canonicalStringify(target.getGlobalStats());
      if (a !== b) mismatches.push('globalStats: 内容漂移');
    }

    return { lossless: mismatches.length === 0, checked, mismatches };
  }

  /**
   * 跨租户迁移：源记忆库 → 目标记忆库
   * @param sourceMemory 源租户记忆库
   * @param targetMemory 目标租户记忆库
   * @param options 迁移选项（范围 + 策略）
   */
  migrateBetweenTenants(
    sourceMemory: LongTermMemory,
    targetMemory: LongTermMemory,
    options?: ExportOptions & { strategy?: MergeStrategy },
  ): MigrationReport {
    const pkg = this.exportFromMemory(sourceMemory, options);
    return this.importToMemory(targetMemory, pkg, options?.strategy ?? 'merge');
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 构建带校验和的迁移包 */
  private buildPackage(data: MigrationPackage['data'], opts: ExportOptions): MigrationPackage {
    const pkg: MigrationPackage = {
      version: PACKAGE_VERSION,
      exportedAt: Date.now(),
      source: {
        instanceId: this.instanceId,
        instanceName: opts.instanceName,
        pluginVersion: PLUGIN_VERSION,
      },
      scope: {
        includePatterns: opts.includePatterns ?? true,
        includeModelProfiles: opts.includeModelProfiles ?? true,
        includeFeedback: opts.includeFeedback ?? true,
        includeSemanticMemories: opts.includeSemanticMemories ?? true,
        includeProceduralMemories: opts.includeProceduralMemories ?? true,
        includeGlobalStats: opts.includeGlobalStats ?? true,
        tenantFilter: opts.tenantFilter,
      },
      checksum: this.computeChecksum(data),
      data,
    };
    return pkg;
  }

  /** 计算 data 段的 SHA-256（深度键序规范化序列化，与键序无关） */
  private computeChecksum(data: MigrationPackage['data']): string {
    return crypto.createHash('sha256').update(this.canonicalStringify(data)).digest('hex');
  }

  /** 递归按键名排序的规范化 JSON 序列化（保证任意嵌套层级的确定性） */
  private canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.canonicalStringify(v)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${this.canonicalStringify(record[k])}`).join(',')}}`;
  }

  /** 校验迁移包完整性 */
  private verifyChecksum(pkg: MigrationPackage): void {
    if (!pkg || typeof pkg !== 'object' || !pkg.data || typeof pkg.checksum !== 'string') {
      throw new MemoryError('迁移包结构非法：缺少 data 或 checksum');
    }
    const expected = this.computeChecksum(pkg.data);
    // timingSafeEqual 对不等长缓冲直接抛 RangeError：先做长度检查，
    // 保证任何形态的不匹配都落到 MemoryError 契约（而非裸 RangeError）
    if (expected.length !== pkg.checksum.length || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(pkg.checksum, 'hex'))) {
      throw new MemoryError('迁移包校验和不匹配：数据可能已损坏或被篡改');
    }
  }

  /**
   * 任务模式冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolvePatternConflict(local: TaskPatternMemory, remote: TaskPatternMemory, strategy: MergeStrategy): TaskPatternMemory | null {
    switch (strategy) {
      case 'overwrite':
        return remote;
      case 'skip':
        return null;
      case 'newer-wins':
        return remote.lastSeenAt >= local.lastSeenAt ? remote : local;
      case 'merge':
      default:
        return this.mergePatterns(local, remote);
    }
  }

  /** 深度合并两个任务模式：方案并集 + 记录并集 + 统计重算 */
  private mergePatterns(local: TaskPatternMemory, remote: TaskPatternMemory): TaskPatternMemory {
    // 成功方案按 timestamp 去重合并
    const planKey = (p: { timestamp: number; totalLatency: number; tokenCost: number }) =>
      `${p.timestamp}:${p.totalLatency}:${p.tokenCost}`;
    const planMap = new Map<string, (typeof local.successfulPlans)[number]>();
    for (const p of [...local.successfulPlans, ...remote.successfulPlans]) {
      planMap.set(planKey(p), p);
    }
    const successfulPlans = [...planMap.values()].sort((a, b) => b.timestamp - a.timestamp);

    // 失败记录按 timestamp+errorMessage 去重合并
    const failKey = (f: { timestamp: number; errorMessage: string }) => `${f.timestamp}:${f.errorMessage}`;
    const failMap = new Map<string, (typeof local.failureRecords)[number]>();
    for (const f of [...local.failureRecords, ...remote.failureRecords]) {
      failMap.set(failKey(f), f);
    }
    const failureRecords = [...failMap.values()].sort((a, b) => b.timestamp - a.timestamp);

    const avg = (values: number[]): number =>
      values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;

    return {
      fingerprint: local.fingerprint,
      taskSummary: local.taskSummary,
      frequency: local.frequency + remote.frequency,
      firstSeenAt: Math.min(local.firstSeenAt, remote.firstSeenAt),
      lastSeenAt: Math.max(local.lastSeenAt, remote.lastSeenAt),
      // 衰减基准随合并保留（缺省口径 = lastSeenAt）：原实现丢弃该字段会让
      // 下次遗忘曲线从合并后的 lastSeenAt 重新起算，已衰减过的置信度被二次衰减
      lastDecayAt: Math.max(local.lastDecayAt ?? local.lastSeenAt, remote.lastDecayAt ?? remote.lastSeenAt),
      successfulPlans,
      failureRecords,
      // 置信度取加权平均（按频率加权）
      confidence:
        (local.confidence * local.frequency + remote.confidence * remote.frequency) /
        Math.max(1, local.frequency + remote.frequency),
      bestModelCombination: remote.lastSeenAt >= local.lastSeenAt ? remote.bestModelCombination : local.bestModelCombination,
      avgExecutionTime: avg(successfulPlans.map((p) => p.totalLatency)),
      avgQualityScore: avg(
        successfulPlans.map((p) => {
          const values = Object.values(p.qualityScores);
          return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
        }),
      ),
    };
  }

  /**
   * 模型画像冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProfileConflict(local: ModelLongTermProfile, remote: ModelLongTermProfile, strategy: MergeStrategy): ModelLongTermProfile | null {
    switch (strategy) {
      case 'overwrite':
        return remote;
      case 'skip':
        return null;
      case 'newer-wins': {
        const localLast = Math.max(0, ...Object.values(local.taskHistory).map((h) => h.lastCalledAt));
        const remoteLast = Math.max(0, ...Object.values(remote.taskHistory).map((h) => h.lastCalledAt));
        return remoteLast >= localLast ? remote : local;
      }
      case 'merge':
      default:
        return this.mergeProfiles(local, remote);
    }
  }

  /** 深度合并两个模型画像：taskHistory 按任务类型累加 */
  private mergeProfiles(local: ModelLongTermProfile, remote: ModelLongTermProfile): ModelLongTermProfile {
    const taskHistory: ModelLongTermProfile['taskHistory'] = {};
    const types = new Set([...Object.keys(local.taskHistory), ...Object.keys(remote.taskHistory)]);
    for (const type of types) {
      const l = local.taskHistory[type];
      const r = remote.taskHistory[type];
      if (l && r) {
        taskHistory[type] = {
          totalCalls: l.totalCalls + r.totalCalls,
          successCount: l.successCount + r.successCount,
          totalLatency: l.totalLatency + r.totalLatency,
          totalQualityScore: l.totalQualityScore + r.totalQualityScore,
          avgQualityScore:
            l.successCount + r.successCount > 0
              ? (l.totalQualityScore + r.totalQualityScore) / (l.successCount + r.successCount)
              : 0,
          lastCalledAt: Math.max(l.lastCalledAt, r.lastCalledAt),
          // 2.0 证据字段随合并保留（缺失侧按裸计数折算）：原实现重建对象时
          // 丢弃加权证据与 EMA——迁移后画像被降级为 legacy 口径（0.5 折价），
          // 证据量静默减半、漂移检测样本不足
          weightedSuccesses: (l.weightedSuccesses ?? l.successCount) + (r.weightedSuccesses ?? r.successCount),
          weightedFailures:
            (l.weightedFailures ?? l.totalCalls - l.successCount) + (r.weightedFailures ?? r.totalCalls - r.successCount),
          lastDecayedAt: Math.max(l.lastDecayedAt ?? 0, r.lastDecayedAt ?? 0),
          emaQuality: l.emaQuality ?? r.emaQuality,
        };
      } else {
        taskHistory[type] = { ...(l ?? r)! };
      }
    }

    // 成本效率取双方均值
    const costEfficiency: Record<string, number> = { ...local.costEfficiency };
    for (const [type, value] of Object.entries(remote.costEfficiency)) {
      costEfficiency[type] = costEfficiency[type] !== undefined ? (costEfficiency[type] + value) / 2 : value;
    }

    // best/worst 从合并后的历史重新推导
    const ranked = Object.entries(taskHistory)
      .filter(([, h]) => h.totalCalls >= 2)
      .sort((a, b) => b[1].successCount / b[1].totalCalls - a[1].successCount / a[1].totalCalls);

    return {
      id: local.id,
      name: local.name,
      taskHistory,
      costEfficiency,
      bestTaskType: ranked[0]?.[0] ?? local.bestTaskType,
      worstTaskType: ranked[ranked.length - 1]?.[0] ?? local.worstTaskType,
      stability: (local.stability + remote.stability) / 2,
    };
  }

  /**
   * 语义记忆冲突仲裁（4.0 补全）
   *
   * merge 不做二选一：交给记忆库 upsert 的证据合并语义（同 id 覆盖时
   * 继承既有 evidence 与应用反馈统计；同 statement 时支撑累加合并）。
   * newer-wins 按 max(distilledAt, lastAppliedAt) 仲裁。
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveSemanticConflict(local: SemanticMemory, remote: SemanticMemory, strategy: MergeStrategy): SemanticMemory | null {
    switch (strategy) {
      case 'overwrite':
        return remote;
      case 'skip':
        return null;
      case 'newer-wins': {
        const freshness = (m: SemanticMemory): number => Math.max(m.distilledAt, m.lastAppliedAt ?? 0);
        return freshness(remote) >= freshness(local) ? remote : local;
      }
      case 'merge':
      default:
        return remote;
    }
  }

  /**
   * 程序记忆冲突仲裁（4.0 补全；语义同 resolveSemanticConflict）
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProceduralConflict(local: ProceduralMemory, remote: ProceduralMemory, strategy: MergeStrategy): ProceduralMemory | null {
    switch (strategy) {
      case 'overwrite':
        return remote;
      case 'skip':
        return null;
      case 'newer-wins': {
        const freshness = (m: ProceduralMemory): number => Math.max(m.distilledAt, m.lastAppliedAt ?? 0);
        return freshness(remote) >= freshness(local) ? remote : local;
      }
      case 'merge':
      default:
        return remote;
    }
  }
}
