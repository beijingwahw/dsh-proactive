/**
 * hot-reload-engine.ts — 插件热更新引擎（协作层，独立模块）
 *
 * 职责：在不中断服务的前提下完成插件代码的版本迭代
 * - 监听源码目录变更（防抖合并）
 * - 触发构建命令并校验产物
 * - 优雅停机（等待活跃任务完成）→ 版本切换 → 失败自动回滚
 * - 版本历史管理（保留 N 个历史版本，支持手动部署与回滚）
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 完整版本生命周期状态机：deploying → active → rolling-back → retired/failed，
 *    每次部署生成内容哈希指纹，杜绝重复部署相同代码
 * 2. 优雅停机双保险：先等待活跃任务自然结束（gracefulShutdownTimeout），
 *    超时后强制切换，保证热更新不会无限阻塞
 * 3. 构建产物校验：部署前检查 distDir/entryFile 存在性与代码哈希，
 *    构建失败自动触发 rollback（autoRollback）
 * 4. 事件流全量广播：15 种 HotReloadEvent 通过 EventEmitter 推送，
 *    集成层可桥接到 ProgressBroadcaster 的 plugin-reloaded 事件
 * 5. 版本历史磁盘持久化：versions.json 记录全部版本元数据，
 *    重启后可回滚到任意历史版本
 *
 * 第三轮·世界性升级（模块域 A12）：
 * 6. 模块依赖重排：registerModuleDependency 声明模块依赖（成环拒绝），
 *    reloadAffectedModules 对「变更模块的依赖闭包」做 Kahn 拓扑排序——
 *    变更传播严格按「依赖先于依赖者」重载，闭包外模块零触碰；
 *    attachModuleGraph 可把文件监听映射进模块图（未挂载零漂移）
 * 7. 原子交换与回滚：deployAtomic 在新版本 initialize 成功前永不让
 *    active 离开旧版本——初始化 throw 时自动回滚旧版本并返回结构化
 *    失败诊断（phase/error/stack/restoredVersion），事件流完整审计
 *
 * 第四轮·世界性升级（模块域 A12，加分项）：
 * 8. 灰度发布：canaryDeploy 把变更拆成「灰度单元 + 全量铺开」两阶段——
 *    先重载灰度模块并跑健康探针（超时/异常/返回不健康均判失败），探针
 *    失败只回滚灰度单元（rollback 处理器逐个恢复）、全量集合零触碰，
 *    其余模块完全不受影响；探针全过再按拓扑序全量铺开（fail-fast 保留）
 */

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 插件版本记录 */
export interface PluginVersion {
  version: string;
  codeHash: string;
  bundlePath: string;
  deployedAt: number;
  source: 'file-watch' | 'manual' | 'remote';
  active: boolean;
  status: 'deploying' | 'active' | 'rolling-back' | 'failed' | 'retired';
  error?: string;
}

/** 热更新配置 */
export interface HotReloadConfig {
  enabled: boolean;
  watchDirs: string[];
  watchExtensions: string[];
  /** 防抖窗口（毫秒） */
  debounceMs: number;
  buildCommand: string;
  distDir: string;
  entryFile: string;
  maxVersionHistory: number;
  gracefulShutdownTimeout: number;
  versionsDir: string;
  autoRollback: boolean;
}

/** 活跃任务记录 */
export interface ActiveTask {
  id: string;
  type: string;
  startedAt: number;
  version: string;
}

/** 热更新事件（15 种） */
export type HotReloadEvent =
  | { type: 'file-changed'; filePath: string; timestamp: number }
  | { type: 'compilation-started'; version: string; timestamp: number }
  | { type: 'compilation-succeeded'; version: string; duration: number; timestamp: number }
  | { type: 'compilation-failed'; version: string; error: string; timestamp: number }
  | { type: 'deploy-started'; version: string; timestamp: number }
  | { type: 'deploy-succeeded'; version: string; previousVersion: string | null; timestamp: number }
  | { type: 'deploy-failed'; version: string; error: string; timestamp: number }
  | { type: 'rollback-started'; fromVersion: string; toVersion: string; timestamp: number }
  | { type: 'rollback-succeeded'; version: string; timestamp: number }
  | { type: 'rollback-failed'; error: string; timestamp: number }
  | { type: 'graceful-shutdown-started'; version: string; activeTasks: number; timestamp: number }
  | { type: 'graceful-shutdown-completed'; version: string; timestamp: number }
  // ── 第三轮：模块依赖重排 + 原子交换 ──
  | { type: 'module-reload-scheduled'; modules: string[]; order: string[]; skipped: string[]; timestamp: number }
  | { type: 'module-reloaded'; moduleId: string; sequence: number; durationMs: number; timestamp: number }
  | { type: 'module-reload-failed'; moduleId: string; error: string; timestamp: number }
  // ── 第四轮：灰度发布 ──
  | { type: 'canary-phase-started'; canary: string[]; rollout: string[]; timestamp: number }
  | { type: 'canary-probe-passed'; moduleId: string; timestamp: number }
  | { type: 'canary-probe-failed'; moduleId: string; reason: string; timestamp: number }
  | { type: 'canary-rollback-succeeded'; modules: string[]; timestamp: number }
  | { type: 'canary-rollback-failed'; moduleId: string; error: string; timestamp: number }
  | { type: 'canary-completed'; aborted: boolean; canaryReloaded: string[]; rolledOut: string[]; timestamp: number };

// ─────────────────────────── 模块依赖图（第三轮） ───────────────────────────

/** 模块依赖视图条目 */
export interface ModuleDependencyInfo {
  moduleId: string;
  dependsOn: string[];
  dependents: string[];
  registrationIndex: number;
}

/** 模块依赖图视图（拓扑序 + 无环判定） */
export interface ModuleGraphView {
  modules: ModuleDependencyInfo[];
  /** 全图拓扑序（依赖先于依赖者；注册序为确定性平局裁决） */
  order: string[];
  acyclic: boolean;
  cycle: string[];
}

/** 变更传播报告 */
export interface ModuleReloadReport {
  /** 受影响闭包的拓扑序（依赖在前） */
  order: string[];
  /** 闭包内实际重载完成的模块 */
  reloaded: string[];
  /** 闭包外/未注册而被跳过的变更目标 */
  skipped: string[];
  /** 重载失败（fail-fast：首个失败后其余依赖者不再执行） */
  failed: Array<{ moduleId: string; error: string }>;
  /** 未设置 reloader 时为 true（纯排序演算，零副作用） */
  dryRun: boolean;
}

/** 模块重载器（集成层提供：每个模块如何完成自己的重初始化） */
export type ModuleReloader = (moduleId: string, context: { triggers: string[]; sequence: number }) => Promise<void> | void;

/** 模块图接线（文件路径 → 模块 id 解析；挂载后文件监听走依赖重排管线） */
export interface ModuleGraphAttachment {
  resolveFile: (filePath: string) => string[];
}

// ─────────────────────────── 灰度发布（第四轮） ───────────────────────────

/** 灰度发布选项 */
export interface CanaryDeployOptions {
  /** 目标模块清单（应为已注册模块；未注册记入 skipped） */
  modules: string[];
  /** 灰度单元：先重载 + 探针验证的子集（缺省取 modules 中首个已注册模块） */
  canary?: string[];
  /** 健康探针：返回 false 或 throw 视为失败（缺省视为通过） */
  probe?: (moduleId: string) => boolean | Promise<boolean>;
  /** 探针失败后灰度单元的回滚器（缺省仅中止不回滚） */
  rollback?: (moduleId: string) => Promise<void> | void;
  /** 探针超时（毫秒，默认 5000） */
  probeTimeoutMs?: number;
}

/** 灰度发布报告 */
export interface CanaryDeployReport {
  /** 灰度阶段计划重载的模块（拓扑序） */
  canaryPlanned: string[];
  /** 灰度阶段实际重载完成的模块 */
  canaryReloaded: string[];
  /** 探针失败后已回滚的灰度模块 */
  canaryRolledBack: string[];
  /** 全量阶段铺开完成的模块 */
  rolledOut: string[];
  /** 未注册而被跳过的目标 */
  skipped: string[];
  /** 重载器抛错的模块（fail-fast 中止） */
  failed: Array<{ moduleId: string; error: string }>;
  /** 探针失败明细（模块 + 原因） */
  probeFailures: Array<{ moduleId: string; reason: string }>;
  /** true = 灰度阶段失败（重载抛错或探针不健康），全量铺开未开始（其余模块零触碰） */
  aborted: boolean;
  durationMs: number;
}

// ─────────────────────────── 原子交换（第三轮） ───────────────────────────

/** 原子交换选项 */
export interface AtomicSwapOptions {
  /** 新版本初始化钩子——throw 即触发回滚 */
  initialize?: () => void | Promise<void>;
  /** 显式版本号（缺省 v-<36进制时间戳>） */
  version?: string;
  codeHash?: string;
  bundlePath?: string;
  source?: PluginVersion['source'];
}

/** 原子交换失败诊断 */
export interface AtomicSwapFailure {
  phase: 'initialize' | 'busy';
  error: string;
  stack?: string;
}

/** 原子交换结果 */
export interface AtomicSwapResult {
  version: string;
  /** 新版本成功激活 */
  swapped: boolean;
  /** 初始化失败后旧版本被确认为仍激活 */
  rolledBack: boolean;
  restoredVersion: string | null;
  durationMs: number;
  failure?: AtomicSwapFailure;
}

/** 热重载状态（运维可观测） */
export interface HotReloadStatus {
  enabled: boolean;
  watching: boolean;
  deploying: boolean;
  activeVersion: string | null;
  activeTaskCount: number;
  versionCount: number;
  recentVersions: Array<{ version: string; status: string; deployedAt: number; source: string }>;
}

/**
 * 插件热更新引擎
 *
 * 被 index.ts 的 manage_hot_reload Tool 调用
 * （status / rollback / deploy-version / stop-watching / start-watching）。
 */
export class HotReloadEngine extends EventEmitter {
  private config: HotReloadConfig;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private versions: PluginVersion[] = [];
  private activeTasks = new Map<string, ActiveTask>();
  private versionsIndexPath: string;
  private deploying = false;
  private watching = false;

  // ── 模块依赖图（第三轮；未注册/未挂载零介入） ──
  /** moduleId → 依赖集合 */
  private moduleDeps = new Map<string, Set<string>>();
  /** 注册序（Kahn 拓扑排序的确定性平局裁决） */
  private moduleOrder = new Map<string, number>();
  /** 模块重载器（集成层注入；缺省纯排序演算零副作用） */
  private moduleReloader: ModuleReloader | null = null;
  /** 文件 → 模块图接线（挂载后文件监听走依赖重排管线） */
  private moduleGraph: ModuleGraphAttachment | null = null;

  constructor(config: HotReloadConfig) {
    super();
    this.config = config;
    this.versionsIndexPath = path.join(config.versionsDir, 'versions.json');
    this.loadVersions();
  }

  /**
   * 启动文件监听（enabled=false 时为空操作）
   */
  startWatching(): void {
    if (!this.config.enabled || this.watching) return;
    this.watching = true;
    for (const dir of this.config.watchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const ext = path.extname(filename);
          if (!this.config.watchExtensions.includes(ext)) return;
          this.emitEvent({ type: 'file-changed', filePath: filename, timestamp: Date.now() });
          this.scheduleReload(filename);
        });
        this.watchers.push(watcher);
      } catch {
        /* 单目录监听失败不阻塞其他目录 */
      }
    }
  }

  /**
   * 停止文件监听
   */
  stopWatching(): void {
    this.watching = false;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * 注册活跃任务（执行层开始子任务时调用）
   */
  registerTask(taskId: string, taskType: string): void {
    this.activeTasks.set(taskId, {
      id: taskId,
      type: taskType,
      startedAt: Date.now(),
      version: this.getActiveVersion()?.version ?? 'unknown',
    });
  }

  /**
   * 注销活跃任务（子任务完成/失败时调用）
   */
  unregisterTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  /** 当前活跃任务数 */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * 回滚到上一个 active 历史版本
   * @throws 无可回滚版本时 reject
   */
  async rollback(): Promise<void> {
    const current = this.getActiveVersion();
    // 找最近一个非当前的 active/retired 版本
    const target = [...this.versions]
      .sort((a, b) => b.deployedAt - a.deployedAt)
      .find((v) => v.version !== current?.version && v.status !== 'failed');
    if (!target) {
      const error = '没有可回滚的历史版本';
      this.emitEvent({ type: 'rollback-failed', error, timestamp: Date.now() });
      throw new Error(error);
    }
    this.emitEvent({
      type: 'rollback-started',
      fromVersion: current?.version ?? 'none',
      toVersion: target.version,
      timestamp: Date.now(),
    });
    try {
      await this.gracefulShutdown(current?.version ?? 'none');
      if (current) {
        current.active = false;
        current.status = 'retired';
      }
      target.active = true;
      target.status = 'active';
      this.persistVersions();
      this.emitEvent({ type: 'rollback-succeeded', version: target.version, timestamp: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({ type: 'rollback-failed', error: message, timestamp: Date.now() });
      throw err;
    }
  }

  /**
   * 手动部署指定版本（从版本历史中选择）
   * @param versionId 目标版本号
   */
  async manualDeploy(versionId: string): Promise<void> {
    const target = this.versions.find((v) => v.version === versionId);
    if (!target) {
      throw new Error(`版本不存在: ${versionId}`);
    }
    const current = this.getActiveVersion();
    this.emitEvent({ type: 'deploy-started', version: versionId, timestamp: Date.now() });
    try {
      await this.gracefulShutdown(current?.version ?? 'none');
      if (current) {
        current.active = false;
        current.status = 'retired';
      }
      target.active = true;
      target.status = 'active';
      this.persistVersions();
      this.emitEvent({
        type: 'deploy-succeeded',
        version: versionId,
        previousVersion: current?.version ?? null,
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({ type: 'deploy-failed', version: versionId, error: message, timestamp: Date.now() });
      throw err;
    }
  }

  /**
   * 引擎状态摘要（供 manage_hot_reload status 使用）
   */
  getStatus(): HotReloadStatus {
    const active = this.getActiveVersion();
    return {
      enabled: this.config.enabled,
      watching: this.watching,
      deploying: this.deploying,
      activeVersion: active?.version ?? null,
      activeTaskCount: this.activeTasks.size,
      versionCount: this.versions.length,
      recentVersions: [...this.versions]
        .sort((a, b) => b.deployedAt - a.deployedAt)
        .slice(0, 5)
        .map((v) => ({ version: v.version, status: v.status, deployedAt: v.deployedAt, source: v.source })),
    };
  }

  /**
   * 停止引擎：停止监听并清理
   */
  stop(): void {
    this.stopWatching();
    this.removeAllListeners();
  }

  // ─────────────────────────── 模块依赖重排（第三轮） ───────────────────────────

  /**
   * 声明模块依赖（成环拒绝；重复声明覆盖）。
   * 环会让「依赖先于依赖者」的传播序不存在——注册期即拒绝
   */
  registerModuleDependency(moduleId: string, dependsOn: string[]): boolean {
    if (!moduleId) return false;
    const deps = new Set((dependsOn ?? []).filter((d) => d && d !== moduleId));
    // 环检测：任一新依赖经既有依赖边回到 moduleId 即拒绝
    for (const dep of deps) {
      if (this.wouldCycle(dep, moduleId)) return false;
    }
    if (!this.moduleOrder.has(moduleId)) this.moduleOrder.set(moduleId, this.moduleOrder.size);
    this.moduleDeps.set(moduleId, deps);
    return true;
  }

  /** 模块依赖图视图（含全图拓扑序与无环判定） */
  moduleDependencyView(): ModuleGraphView {
    const dependents = new Map<string, string[]>();
    for (const [m, deps] of this.moduleDeps) {
      for (const d of deps) {
        const list = dependents.get(d) ?? [];
        list.push(m);
        dependents.set(d, list);
      }
    }
    const modules: ModuleDependencyInfo[] = [...this.moduleDeps.keys()]
      .sort((a, b) => (this.moduleOrder.get(a) ?? 0) - (this.moduleOrder.get(b) ?? 0))
      .map((m) => ({
        moduleId: m,
        dependsOn: [...this.moduleDeps.get(m) ?? []].sort(),
        dependents: (dependents.get(m) ?? []).sort(),
        registrationIndex: this.moduleOrder.get(m) ?? 0,
      }));
    const topo = this.topoSort([...this.moduleDeps.keys()]);
    return {
      modules,
      order: topo.order,
      acyclic: topo.acyclic,
      cycle: topo.cycle,
    };
  }

  /** 注入模块重载器（每个模块的重初始化由集成层定义） */
  setModuleReloader(handler: ModuleReloader): void {
    this.moduleReloader = handler;
  }

  /** 挂载文件 → 模块图接线（挂载后命中已注册模块的文件变更走依赖重排管线） */
  attachModuleGraph(attachment: ModuleGraphAttachment): void {
    this.moduleGraph = attachment;
  }

  /**
   * 变更传播：依赖闭包拓扑序重载。
   *
   * - 闭包 = 变更模块 ∪ 其全部传递依赖者（依赖者因依赖变更而失效）
   * - Kahn 拓扑排序（注册序平局裁决）——依赖严格先于依赖者
   * - 闭包外模块零触碰；未注册的变更目标记入 skipped
   * - reloader 缺席时纯排序演算（dry-run，零副作用）
   * - fail-fast：某模块重载失败即停止传播（依赖者不基于坏依赖重初始化）
   */
  async reloadAffectedModules(changed: string[]): Promise<ModuleReloadReport> {
    const registered = (changed ?? []).filter((id) => this.moduleDeps.has(id));
    const skipped = (changed ?? []).filter((id) => !this.moduleDeps.has(id));
    const closure = this.dependencyClosure(registered);
    const { order } = this.topoSort(closure);
    this.emitEvent({
      type: 'module-reload-scheduled',
      modules: [...closure].sort(),
      order,
      skipped: [...new Set(skipped)],
      timestamp: Date.now(),
    });
    if (!this.moduleReloader || order.length === 0) {
      return { order, reloaded: [], skipped: [...new Set(skipped)], failed: [], dryRun: true };
    }
    const reloaded: string[] = [];
    const failed: ModuleReloadReport['failed'] = [];
    let sequence = 0;
    for (const moduleId of order) {
      sequence += 1;
      const startedAt = Date.now();
      try {
        await this.moduleReloader(moduleId, { triggers: [...new Set(registered)], sequence });
        reloaded.push(moduleId);
        this.emitEvent({ type: 'module-reloaded', moduleId, sequence, durationMs: Date.now() - startedAt, timestamp: Date.now() });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ moduleId, error: message });
        this.emitEvent({ type: 'module-reload-failed', moduleId, error: message, timestamp: Date.now() });
        break; // fail-fast：依赖者不基于坏依赖重初始化
      }
    }
    return { order, reloaded, skipped: [...new Set(skipped)], failed, dryRun: false };
  }

  // ─────────────────────────── 灰度发布（第四轮） ───────────────────────────

  /**
   * 灰度发布：先重载灰度单元并验证健康探针，全过再全量铺开。
   *
   * - 阶段一（灰度）：按拓扑序重载 canary 集合，每个模块重载后立即
   *   跑健康探针（false / throw / 超时均判失败）
   * - 探针失败：只回滚灰度单元（rollback 处理器逆序恢复），全量集合
   *   零触碰——「坏版本只回滚灰度单元、其余模块不受影响」；灰度单元
   *   重载本身抛错同样中止（不进入探针与全量铺开，已重载灰度单元照常回滚）
   * - 阶段二（全量）：探针全过后按拓扑序铺开余下模块（fail-fast：
   *   首个重载失败即止，依赖者不基于坏依赖重初始化）
   * - 未设置 moduleReloader 时纯演算（零副作用）
   */
  async canaryDeploy(options: CanaryDeployOptions): Promise<CanaryDeployReport> {
    const startedAt = Date.now();
    const registered = (options.modules ?? []).filter((id) => this.moduleDeps.has(id));
    const skipped = [...new Set((options.modules ?? []).filter((id) => !this.moduleDeps.has(id)))];
    const { order } = this.topoSort(registered);
    const canarySet = new Set((options.canary ?? registered.slice(0, 1)).filter((id) => order.includes(id)));
    const canaryOrder = order.filter((id) => canarySet.has(id));
    const rolloutOrder = order.filter((id) => !canarySet.has(id));
    const report: CanaryDeployReport = {
      canaryPlanned: canaryOrder,
      canaryReloaded: [],
      canaryRolledBack: [],
      rolledOut: [],
      skipped,
      failed: [],
      probeFailures: [],
      aborted: false,
      durationMs: 0,
    };
    this.emitEvent({ type: 'canary-phase-started', canary: canaryOrder, rollout: rolloutOrder, timestamp: Date.now() });
    const reloader = this.moduleReloader;

    // 阶段一：灰度单元重载 + 探针
    for (const moduleId of canaryOrder) {
      if (!reloader) break; // 无重载器：纯演算
      const reloadStartedAt = Date.now();
      try {
        await reloader(moduleId, { triggers: [...new Set(registered)], sequence: report.canaryReloaded.length + 1 });
        report.canaryReloaded.push(moduleId);
        this.emitEvent({
          type: 'module-reloaded',
          moduleId,
          sequence: report.canaryReloaded.length,
          durationMs: Date.now() - reloadStartedAt,
          timestamp: Date.now(),
        });
      } catch (err) {
        report.failed.push({ moduleId, error: err instanceof Error ? err.message : String(err) });
        this.emitEvent({
          type: 'module-reload-failed',
          moduleId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
        report.aborted = true;
        break; // fail-fast：灰度重载即失败——不进入探针与铺开（aborted 阻断全量阶段并触发灰度回滚）
      }
      if (options.probe) {
        const probeResult = await this.runProbe(options.probe, moduleId, options.probeTimeoutMs ?? 5000);
        if (!probeResult.ok) {
          report.probeFailures.push({ moduleId, reason: probeResult.reason ?? '探针不健康' });
          this.emitEvent({ type: 'canary-probe-failed', moduleId, reason: probeResult.reason ?? '探针不健康', timestamp: Date.now() });
          report.aborted = true;
          break;
        }
        this.emitEvent({ type: 'canary-probe-passed', moduleId, timestamp: Date.now() });
      }
    }

    if (report.aborted) {
      // 只回滚灰度单元；rollout 全体不动——其余模块不受影响
      if (options.rollback) {
        for (const moduleId of [...report.canaryReloaded].reverse()) {
          try {
            await options.rollback(moduleId);
            report.canaryRolledBack.push(moduleId);
          } catch (err) {
            this.emitEvent({
              type: 'canary-rollback-failed',
              moduleId,
              error: err instanceof Error ? err.message : String(err),
              timestamp: Date.now(),
            });
          }
        }
        if (report.canaryRolledBack.length > 0) {
          this.emitEvent({ type: 'canary-rollback-succeeded', modules: report.canaryRolledBack, timestamp: Date.now() });
        }
      }
      this.emitEvent({
        type: 'canary-completed',
        aborted: true,
        canaryReloaded: report.canaryReloaded,
        rolledOut: [],
        timestamp: Date.now(),
      });
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    // 阶段二：全量铺开（拓扑序，fail-fast）
    if (reloader) {
      for (const moduleId of rolloutOrder) {
        const reloadStartedAt = Date.now();
        try {
          await reloader(moduleId, {
            triggers: [...new Set(registered)],
            sequence: report.canaryReloaded.length + report.rolledOut.length + 1,
          });
          report.rolledOut.push(moduleId);
          this.emitEvent({
            type: 'module-reloaded',
            moduleId,
            sequence: report.canaryReloaded.length + report.rolledOut.length,
            durationMs: Date.now() - reloadStartedAt,
            timestamp: Date.now(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          report.failed.push({ moduleId, error: message });
          this.emitEvent({ type: 'module-reload-failed', moduleId, error: message, timestamp: Date.now() });
          break; // fail-fast
        }
      }
    }
    this.emitEvent({
      type: 'canary-completed',
      aborted: false,
      canaryReloaded: report.canaryReloaded,
      rolledOut: report.rolledOut,
      timestamp: Date.now(),
    });
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  /** 探针执行（超时/异常/false 三路失败收敛为结构化结果） */
  private runProbe(
    probe: (moduleId: string) => boolean | Promise<boolean>,
    moduleId: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: `探针超时（${timeoutMs}ms）` });
      }, timeoutMs);
      timer.unref?.();
      Promise.resolve()
        .then(() => probe(moduleId))
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result === true ? { ok: true } : { ok: false, reason: '探针返回不健康' });
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
        });
    });
  }

  // ─────────────────────────── 原子交换与回滚（第三轮） ───────────────────────────

  /**
   * 原子交换：新版本 initialize 成功之前，active 永不离开旧版本。
   *
   * - 成功路径：gracefulShutdown → 立档不激活 → initialize → 激活交换
   * - 失败路径：initialize throw → 新档标记 failed（含诊断）→ 旧版本
   *   显式确认为仍激活（原子性：从未失活）→ 事件流完整审计
   *
   * @returns swapped=true 新版本激活；swapped=false 时 failure 携带结构化诊断
   */
  async deployAtomic(options: AtomicSwapOptions = {}): Promise<AtomicSwapResult> {
    const startedAt = Date.now();
    if (this.deploying) {
      return {
        version: options.version ?? 'v-busy',
        swapped: false,
        rolledBack: false,
        restoredVersion: this.getActiveVersion()?.version ?? null,
        durationMs: 0,
        failure: { phase: 'busy', error: '部署进行中（串行化拒绝）' },
      };
    }
    this.deploying = true;
    try {
      const previous = this.getActiveVersion();
      const version = options.version ?? `v-${Date.now().toString(36)}`;
      this.emitEvent({ type: 'deploy-started', version, timestamp: Date.now() });
      await this.gracefulShutdown(previous?.version ?? 'none');
      // 立档不激活：initialize 成功前旧版本持续服务（原子性根基）
      const record: PluginVersion = {
        version,
        codeHash: options.codeHash ?? '',
        bundlePath: options.bundlePath ?? '',
        deployedAt: Date.now(),
        source: options.source ?? 'manual',
        active: false,
        status: 'deploying',
      };
      this.versions.push(record);
      this.trimVersionHistory();
      this.persistVersions();
      try {
        if (options.initialize) await options.initialize();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 4).join('\n') : undefined;
        record.status = 'failed';
        record.error = `初始化失败: ${message}`;
        this.persistVersions();
        if (previous) {
          previous.active = true;
          previous.status = 'active';
          this.persistVersions();
        }
        this.emitEvent({ type: 'deploy-failed', version, error: record.error, timestamp: Date.now() });
        if (previous) {
          this.emitEvent({ type: 'rollback-started', fromVersion: version, toVersion: previous.version, timestamp: Date.now() });
          this.emitEvent({ type: 'rollback-succeeded', version: previous.version, timestamp: Date.now() });
        }
        return {
          version,
          swapped: false,
          rolledBack: previous !== undefined,
          restoredVersion: previous?.version ?? null,
          durationMs: Date.now() - startedAt,
          failure: { phase: 'initialize', error: message, stack },
        };
      }
      // 激活交换（唯一状态翻转点）
      if (previous) {
        previous.active = false;
        previous.status = 'retired';
      }
      record.active = true;
      record.status = 'active';
      this.persistVersions();
      this.emitEvent({
        type: 'deploy-succeeded',
        version,
        previousVersion: previous?.version ?? null,
        timestamp: Date.now(),
      });
      return {
        version,
        swapped: true,
        rolledBack: false,
        restoredVersion: null,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      this.deploying = false;
    }
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 防抖调度重载流程 */
  private scheduleReload(triggerFile: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // 模块图接线命中已注册模块 → 依赖闭包拓扑序重排管线；
      // 否则走经典全量构建管线（未挂载零漂移）
      const modules = this.moduleGraph?.resolveFile(triggerFile) ?? [];
      if (modules.some((id) => this.moduleDeps.has(id))) {
        this.reloadAffectedModules(modules).catch(() => {
          /* 管道内部已发事件，这里兜底 */
        });
        return;
      }
      this.reloadPipeline(triggerFile).catch(() => {
        /* 管道内部已发事件，这里兜底 */
      });
    }, this.config.debounceMs);
    this.debounceTimer.unref?.();
  }

  // ── 模块图内部 ──

  /**
   * 环检测：新增边 (moduleId → dep) 成环 ⟺ dep 经既有依赖边传递依赖 moduleId。
   * 从 dep 出发沿 moduleDeps 深度优先搜索 targetId
   */
  private wouldCycle(dep: string, targetId: string): boolean {
    const visited = new Set<string>();
    const stack = [dep];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === targetId) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const d of this.moduleDeps.get(node) ?? []) stack.push(d);
    }
    return false;
  }

  /** 依赖闭包：种子 ∪ 全部传递依赖者（反向边 BFS） */
  private dependencyClosure(seeds: string[]): string[] {
    const dependents = new Map<string, string[]>();
    for (const [m, deps] of this.moduleDeps) {
      for (const d of deps) {
        const list = dependents.get(d) ?? [];
        list.push(m);
        dependents.set(d, list);
      }
    }
    const closure = new Set<string>(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const node = queue.pop()!;
      for (const dep of dependents.get(node) ?? []) {
        if (!closure.has(dep)) {
          closure.add(dep);
          queue.push(dep);
        }
      }
    }
    return [...closure];
  }

  /**
   * Kahn 拓扑排序（闭包内入度归零出队；注册序为平局裁决——确定性）。
   * 依赖先于依赖者；有环时返回已排序前缀 + acyclic=false + 环成员
   */
  private topoSort(nodes: string[]): { order: string[]; acyclic: boolean; cycle: string[] } {
    const nodeSet = new Set(nodes);
    const inDegree = new Map<string, number>();
    for (const n of nodeSet) inDegree.set(n, 0);
    for (const n of nodeSet) {
      for (const dep of this.moduleDeps.get(n) ?? []) {
        if (nodeSet.has(dep)) inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      }
    }
    const order: string[] = [];
    const ready = [...nodeSet]
      .filter((n) => (inDegree.get(n) ?? 0) === 0)
      .sort((a, b) => (this.moduleOrder.get(a) ?? 0) - (this.moduleOrder.get(b) ?? 0));
    while (ready.length > 0) {
      const node = ready.shift()!;
      order.push(node);
      for (const other of nodeSet) {
        if ((this.moduleDeps.get(other) ?? new Set<string>()).has(node)) {
          const deg = (inDegree.get(other) ?? 0) - 1;
          inDegree.set(other, deg);
          if (deg === 0) {
            ready.push(other);
            ready.sort((a, b) => (this.moduleOrder.get(a) ?? 0) - (this.moduleOrder.get(b) ?? 0));
          }
        }
      }
    }
    const cycle = [...nodeSet].filter((n) => !order.includes(n));
    return { order, acyclic: cycle.length === 0, cycle };
  }

  /** 完整重载管道：构建 → 校验 → 优雅停机 → 切换 */
  private async reloadPipeline(trigger: string): Promise<void> {
    if (this.deploying) return; // 串行化部署
    this.deploying = true;
    const version = `v-${Date.now().toString(36)}`;

    try {
      // 1. 构建
      this.emitEvent({ type: 'compilation-started', version, timestamp: Date.now() });
      const buildStartedAt = Date.now();
      const buildOk = await this.runBuild();
      if (!buildOk.ok) {
        this.emitEvent({ type: 'compilation-failed', version, error: buildOk.error ?? '构建失败', timestamp: Date.now() });
        if (this.config.autoRollback && this.getActiveVersion()) {
          await this.rollback().catch(() => undefined);
        }
        return;
      }
      this.emitEvent({
        type: 'compilation-succeeded',
        version,
        duration: Date.now() - buildStartedAt,
        timestamp: Date.now(),
      });

      // 2. 产物校验
      const bundlePath = path.join(this.config.distDir, this.config.entryFile);
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`构建产物缺失: ${bundlePath}`);
      }
      const codeHash = crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
      // 相同代码不重复部署
      if (this.getActiveVersion()?.codeHash === codeHash) {
        return;
      }

      // 3. 部署
      this.emitEvent({ type: 'deploy-started', version, timestamp: Date.now() });
      const previous = this.getActiveVersion();
      await this.gracefulShutdown(previous?.version ?? 'none');

      const record: PluginVersion = {
        version,
        codeHash,
        bundlePath,
        deployedAt: Date.now(),
        source: 'file-watch',
        active: true,
        status: 'active',
      };
      if (previous) {
        previous.active = false;
        previous.status = 'retired';
      }
      this.versions.push(record);
      this.trimVersionHistory();
      this.persistVersions();
      this.emitEvent({
        type: 'deploy-succeeded',
        version,
        previousVersion: previous?.version ?? null,
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({ type: 'deploy-failed', version, error: message, timestamp: Date.now() });
      if (this.config.autoRollback && this.getActiveVersion()) {
        await this.rollback().catch(() => undefined);
      }
    } finally {
      this.deploying = false;
    }
    void trigger;
  }

  /** 执行构建命令 */
  private runBuild(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const [cmd, ...args] = this.config.buildCommand.split(/\s+/);
      if (!cmd) {
        resolve({ ok: false, error: 'buildCommand 为空' });
        return;
      }
      execFile(cmd, args, { timeout: 120_000, cwd: process.cwd() }, (error, _stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: stderr.slice(0, 500) || error.message });
        } else {
          resolve({ ok: true });
        }
      });
    });
  }

  /**
   * 优雅停机：等待活跃任务结束（超时强制继续）
   */
  private async gracefulShutdown(version: string): Promise<void> {
    const taskCount = this.activeTasks.size;
    if (taskCount === 0) return;
    this.emitEvent({
      type: 'graceful-shutdown-started',
      version,
      activeTasks: taskCount,
      timestamp: Date.now(),
    });
    const deadline = Date.now() + this.config.gracefulShutdownTimeout;
    while (this.activeTasks.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.emitEvent({ type: 'graceful-shutdown-completed', version, timestamp: Date.now() });
  }

  /** 获取当前激活版本 */
  private getActiveVersion(): PluginVersion | undefined {
    return this.versions.find((v) => v.active);
  }

  /** 版本历史上限裁剪（保留 active + 最近 N 个） */
  private trimVersionHistory(): void {
    const sorted = [...this.versions].sort((a, b) => b.deployedAt - a.deployedAt);
    const keep = new Set<string>([this.getActiveVersion()?.version].filter(Boolean) as string[]);
    for (const v of sorted.slice(0, this.config.maxVersionHistory)) keep.add(v.version);
    this.versions = this.versions.filter((v) => keep.has(v.version));
  }

  /** 发射事件（类型安全封装） */
  private emitEvent(event: HotReloadEvent): void {
    this.emit('event', event);
    this.emit(event.type, event);
  }

  /** 加载版本历史 */
  private loadVersions(): void {
    if (!fs.existsSync(this.versionsIndexPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.versionsIndexPath, 'utf-8'));
      if (Array.isArray(raw)) this.versions = raw;
    } catch {
      this.versions = [];
    }
  }

  /** 持久化版本历史 */
  private persistVersions(): void {
    try {
      fs.mkdirSync(this.config.versionsDir, { recursive: true });
      const tmp = `${this.versionsIndexPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.versions, null, 2), 'utf-8');
      fs.renameSync(tmp, this.versionsIndexPath);
    } catch {
      /* 版本历史持久化失败不阻塞部署 */
    }
  }
}
