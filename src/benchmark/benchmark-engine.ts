/**
 * benchmark-engine.ts — 性能基准测试引擎（能力层，依赖 long-term-memory + crypto-engine）
 *
 * 职责：
 * - 场景化压测：按 target 维度（sentinel/strategist/executor/memory/sync/
 *   consensus/encryption/full-pipeline）注册并执行基准场景
 * - 统计计算：成功率、延迟分位数（p50/p90/p95/p99）、标准差、吞吐率、峰值内存
 * - 阈值门禁：每类 target 有默认性能阈值，违反即判定不通过
 * - 报告管理：持久化报告、历史对比、Markdown 报告生成
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 真实并发池：按 scenario.concurrency 并发调度 + 预热阶段（warmupRequests
 *    结果不计入统计），避免 JIT 冷启动污染数据
 * 2. 无侵入内置场景：memory / encryption 场景直接压测真实模块，
 *    strategist / executor 等需要 LLM 的场景在 callLLM 缺省时自动跳过并标注原因，
 *    保证离线环境也能产出有效报告
 * 3. 分 target 阈值门禁：不同 target 使用不同阈值（如 encryption 要求 p95 < 50ms，
 *    full-pipeline 放宽到 p95 < 30s），阈值违反逐条列出
 * 4. 延迟分布直方图：指数分桶（<1ms / 1-10ms / ... / >10s），直观呈现长尾
 * 5. 报告对比：compareReports 输出逐场景的延迟与吞吐变化率，用于回归检测
 *
 * 第三轮 A15 升级（世界性升级——统计结论从「点分」到「携带证据」）：
 * 6. 成对统计检验：pairedSignTest 精确二项符号检验 + bootstrapDifferenceCi
 *    种子化自助置信区间——模型对比从「均值谁大」升级为「差异是否显著、
 *    差多少（CI）」，并列 / 显著 / 方向三态诚实裁决
 * 7. e-过程回归检测器：BenchmarkRegressionDetector 以资本过程
 *    e_t = Π(1 + λ_i(x_i − μ0))（λ 可预测、|λ| ≤ 1/2）累积「质量低于基线」
 *    的证据，e ≥ 1/α 报警——Ville 不等式保证任意时刻（含边看边查的
 *    偷看口径）误报率 ≤ α；对齐 12.0 任意时刻证据思想自实现（不 import）
 * 8. BAI 聚焦跑分预算：planBenchmarkBudget 对接已挂载的 73.0 视图——
 *    attachBaiSelector 则以逐次减半锦标赛（自实现对齐 73.0 口径）把
 *    下一轮确认预算砸向难分臂，否则均匀分配；同预算识别率 ≥ 均匀
 *    （见 scripts/verify-mod-bench-dash.mjs）
 * 9. 结构化报告导出：exportStructuredReport 输出 JSON（分数 + CI +
 *    检验结论 + 可执行建议）——机器可读的基准结论面
 *
 * 第四轮 R4-A15 升级（激活与深化——从「单轮结论」到「跨轮记忆」）：
 * 10. 长期基准追踪：BenchmarkTrendTracker 滚动存档模型/场景分数历史，
 *     Theil–Sen 稳健趋势斜率 + Mann–Kendall 非参趋势显著性 + 「最近 N 次
 *     均值 vs 历史基线」Mann–Whitney 对照——分数漂移（先稳后降）检出不受
 *     单点噪声影响，平稳流零误报（α 纪律）；attachTrendTracker 挂载后
 *     runAll 逐场景喂分并附报告 trendTracking（缺省零漂移）
 * 11. 模型推荐引擎：BenchmarkRecommender 按「任务特征（类型/复杂度/预算）
 *     →最优模型」历史表推荐——同型半径内反距离加权插值（IDW 泛化），
 *     未知特征诚实回退全局最优（mode='global-fallback' 不装懂）；
 *     recordOutcome 滚动统计推荐命中率（> 随机基线才算数）
 * 12. 基准对比矩阵：buildBenchmarkMatrix 多模型×多场景对比矩阵——每格 =
 *     相对场景最优的百分比 + 与最优流的成对符号检验显著性标记（★最优 /
 *     **显著劣于 / ns 统计上分不出），heat 字段为热力图数据结构；显著性
 *     标记与第三轮 pairedSignTest 逐对检验完全一致（同一函数裁决）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, TimeoutError } from '../errors.js';
import { ocbaAllocate } from '../core/budget-allocation.js';
// 创世纪 73.0：最佳臂识别（引擎锦标赛——下一轮确认预算砸给谁）
import { successiveHalving, hComplexity } from '../core/best-arm-identification.js';

// 第二轮创世纪 93.0：AutoML Hyperband（连续配置空间 × 可提前终止的全
// 预算曲线寻优——引擎内超参层，与 73.0 BAI 的离散臂选型正交）
import { hyperbandTune } from '../engines-frontier/autonomy25.js';
import type { HyperbandResult, ConfigSource } from '../core/automl-hyperband.js';
import { LongTermMemory } from '../memory/long-term-memory.js';
import type { CryptoEngine } from '../security/crypto-engine.js';
import { Sentinel } from '../sentinel.js';
import { DistributedSync } from '../sync/distributed-sync.js';
import { RaftEngine } from '../consensus/raft-engine.js';
import { CircuitBreakerRegistry, backoffDelayMs, classifyError } from '../core/resilience.js';

/** 单次迭代结果 */
export interface BenchmarkResult {
  success: boolean;
  latency: number;
  error?: string;
  memoryUsed?: number;
  tokensUsed?: number;
}

/** 基准场景定义 */
export interface BenchmarkScenario {
  name: string;
  description: string;
  target:
    | 'sentinel'
    | 'strategist'
    | 'executor'
    | 'memory'
    | 'sync'
    | 'consensus'
    | 'encryption'
    | 'full-pipeline';
  concurrency: number;
  totalRequests: number;
  warmupRequests: number;
  timeout: number;
  execute: (iteration: number) => Promise<BenchmarkResult>;
  /** 场景资源回收钩子（全部迭代结束后调用一次；如关闭哨兵/Raft 服务） */
  teardown?: () => void | Promise<void>;
}

/** 聚合统计 */
export interface BenchmarkStats {
  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50Latency: number;
  p90Latency: number;
  p95Latency: number;
  p99Latency: number;
  stdDev: number;
  /** 每秒完成请求数 */
  throughput: number;
  totalDuration: number;
  peakMemoryMB: number;
  errorDistribution: Record<string, number>;
}

/** 性能阈值 */
export interface PerformanceThreshold {
  maxP95Latency: number;
  minThroughput: number;
  minSuccessRate: number;
  maxP99Latency: number;
}

/** 基准报告 */
export interface BenchmarkReport {
  id: string;
  timestamp: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpuCount: number;
    totalMemoryMB: number;
    pluginVersion: string;
  };
  scenarios: Array<{
    name: string;
    description: string;
    target: string;
    concurrency: number;
    stats: BenchmarkStats;
    passed: boolean;
    thresholdViolations: string[];
    latencyDistribution: Array<{ bucket: string; count: number }>;
  }>;
  overallPassed: boolean;
  totalDuration: number;
  /** 45.0：OCBA 瓶颈聚焦（attachOcbaAllocator 后附加——下一轮确认预算的最优分配） */
  bottleneckFocus?: {
    candidate: string | undefined;
    rationale: string | undefined;
    allocation: Array<{ name: string; count: number }>;
  };
  /**
   * 73.0：最佳臂识别聚焦（attachBaiSelector 后附加——引擎锦标赛冠军）。
   * 与 45.0 OCBA 的分工：OCBA 答「确认预算怎么分」，BAI 答「选型阶段
   * 谁是冠军」（一次性结论最优 vs 持续运行最优——21.0 Gittins 管运行）。
   */
  baiFocus?: {
    recommended: string | undefined;
    rationale: string | undefined;
    samplesPerArm: number[];
    rounds: number;
    hComplexity: number;
  };
  /**
   * 第三轮 A15：e-过程回归告警（attachRegressionDetector 后附加——
   * 逐场景成功率进资本过程，累积证据 e ≥ 1/α 报警，偷看免疫）。
   */
  regressionAlarm?: RegressionAlarmView;
  /**
   * 第三轮 A15：下一轮跑分预算计划（对接 73.0 BAI 挂载视图——
   * attachBaiSelector 则 SH 锦标赛聚焦，否则均匀；纯计划口径零漂移）。
   */
  budgetPlan?: BenchmarkBudgetPlan;
  /**
   * 第四轮 R4-A15：长期基准追踪（attachTrendTracker 后附加——逐场景
   * 成功率滚动存档的趋势视图：斜率 + 显著性 + 近窗 vs 历史基线）。
   */
  trendTracking?: BenchmarkTrendSnapshot;
}

/** 内置场景上下文 */
export interface BuiltinScenarioContext {
  memory: LongTermMemory;
  cryptoEngine: CryptoEngine;
  callLLM: Function;
  models: Array<{ id: string; endpoint: string; apiKey: string }>;
}

/** 分 target 默认阈值 */
const DEFAULT_THRESHOLDS: Record<BenchmarkScenario['target'], PerformanceThreshold> = {
  sentinel: { maxP95Latency: 100, minThroughput: 50, minSuccessRate: 0.99, maxP99Latency: 300 },
  strategist: { maxP95Latency: 15000, minThroughput: 0.05, minSuccessRate: 0.9, maxP99Latency: 30000 },
  executor: { maxP95Latency: 20000, minThroughput: 0.05, minSuccessRate: 0.9, maxP99Latency: 45000 },
  memory: { maxP95Latency: 20, minThroughput: 100, minSuccessRate: 0.999, maxP99Latency: 100 },
  sync: { maxP95Latency: 200, minThroughput: 20, minSuccessRate: 0.99, maxP99Latency: 500 },
  consensus: { maxP95Latency: 500, minThroughput: 10, minSuccessRate: 0.99, maxP99Latency: 1000 },
  encryption: { maxP95Latency: 50, minThroughput: 50, minSuccessRate: 0.999, maxP99Latency: 200 },
  'full-pipeline': { maxP95Latency: 30000, minThroughput: 0.02, minSuccessRate: 0.85, maxP99Latency: 60000 },
};

/** 延迟分布桶边界（毫秒） */
const LATENCY_BUCKETS: Array<{ bucket: string; max: number }> = [
  { bucket: '<1ms', max: 1 },
  { bucket: '1-10ms', max: 10 },
  { bucket: '10-50ms', max: 50 },
  { bucket: '50-100ms', max: 100 },
  { bucket: '100-500ms', max: 500 },
  { bucket: '500ms-1s', max: 1000 },
  { bucket: '1-5s', max: 5000 },
  { bucket: '5-10s', max: 10000 },
  { bucket: '>10s', max: Infinity },
];

/** 插件版本（与 package.json 对齐） */
const PLUGIN_VERSION = '0.1.0';

/**
 * 性能基准测试引擎
 *
 * 被 index.ts 的 run_benchmark Tool 调用
 * （run-all / list-scenarios / list-reports / compare / generate-report）。
 */
export class BenchmarkEngine {
  private reportDir: string;
  private scenarios = new Map<string, BenchmarkScenario>();
  private thresholds: Record<string, PerformanceThreshold> = { ...DEFAULT_THRESHOLDS };

  /**
   * @param reportDir 报告持久化目录（如 .scheduler/benchmarks）
   */
  constructor(reportDir: string) {
    this.reportDir = reportDir;
    fs.mkdirSync(reportDir, { recursive: true });
  }

  /**
   * 注册自定义场景（同名覆盖）
   */
  registerScenario(scenario: BenchmarkScenario): void {
    this.scenarios.set(scenario.name, scenario);
  }

  /**
   * 覆盖指定 target 的性能阈值
   */
  setThreshold(target: BenchmarkScenario['target'], threshold: Partial<PerformanceThreshold>): void {
    this.thresholds[target] = { ...this.thresholds[target]!, ...threshold };
  }

  /** 获取已注册场景名列表 */
  listScenarios(): Array<{ name: string; target: string; concurrency: number; totalRequests: number }> {
    return [...this.scenarios.values()].map((s) => ({
      name: s.name,
      target: s.target,
      concurrency: s.concurrency,
      totalRequests: s.totalRequests,
    }));
  }

  /**
   * 注册内置场景
   *
   * - memory / encryption / sentinel / executor / sync / consensus 场景直接压测
   *   真实模块（离线可运行；executor 压测其弹性内核：熔断/退避/错误分型）
   * - strategist / full-pipeline 场景依赖 context.callLLM，
   *   缺省时注册为"跳过型"场景（执行时立即标注 skipped 原因）
   */
  registerBuiltinScenarios(context: BuiltinScenarioContext): void {
    const { memory, cryptoEngine, callLLM, models } = context;
    const benchStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // ── memory：记忆写入 + 模式检索压测 ──
    this.registerScenario({
      name: 'memory-write-read',
      description: '记忆库写入 + findPattern 检索混合负载',
      target: 'memory',
      concurrency: 8,
      totalRequests: 500,
      warmupRequests: 50,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          if (iteration % 2 === 0) {
            memory.findPattern('code-generation', (iteration % 10) / 10, ['typescript']);
          } else {
            memory.recordDecisionFeedback({
              signalType: 'benchmark',
              signalDescription: `bench-${iteration}`,
              decision: 'execute',
              outcome: 'good',
              outcomeReason: 'benchmark synthetic',
            });
          }
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // ── encryption：字段级加解密回环压测 ──
    this.registerScenario({
      name: 'encryption-roundtrip',
      description: '敏感字段加密 + 解密回环',
      target: 'encryption',
      concurrency: 8,
      totalRequests: 500,
      warmupRequests: 50,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          const payload = { apiKey: `sk-bench-${iteration}`, nested: { password: `pw-${iteration}` }, plain: 'x'.repeat(200) };
          const { result } = cryptoEngine.encryptSensitiveFields(payload);
          cryptoEngine.decryptSensitiveFields(result);
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // ── sentinel：信号注入 + 窗口聚合去重 + 批次交付压测（离线，真实模块） ──
    const benchSentinel = new Sentinel(
      {
        watchCodeChanges: false,
        watchErrors: false,
        watchPerformance: false,
        aggregationWindow: 0.05,
        maxBatchSize: 32,
      },
      () => {
        /* 基准压测不消费批次 */
      },
    );
    this.registerScenario({
      name: 'sentinel-ingest-flush',
      description: '哨兵信号注入 + 窗口聚合去重 + 批次交付',
      target: 'sentinel',
      concurrency: 4,
      totalRequests: 400,
      warmupRequests: 40,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          for (let i = 0; i < 5; i += 1) {
            benchSentinel.ingest({
              type: i % 2 === 0 ? 'code-change' : 'error-detected',
              description: `bench-signal-${iteration}-${i}`,
              payload: { iteration, i },
              source: 'bench',
              // 同 dedupeKey 信号窗口内合并计数（聚合去重热路径）
              dedupeKey: `bench:${iteration % 64}:${i % 2}`,
            });
          }
          benchSentinel.flush('flush');
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
      teardown: () => benchSentinel.stop(),
    });

    // ── executor：执行器弹性内核压测（离线；熔断探测/回报 + 指数退避 + 错误分型） ──
    const benchBreakers = new CircuitBreakerRegistry({ failureThreshold: 5, cooldownMs: 1_000, capacity: 64 });
    this.registerScenario({
      name: 'executor-resilience-kernel',
      description: '执行器弹性内核：模型级熔断探测/回报 + 全抖动退避 + 错误分型',
      target: 'executor',
      concurrency: 4,
      totalRequests: 400,
      warmupRequests: 40,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          const key = `bench-model-${iteration % 8}`;
          const probe = benchBreakers.canExecute(key);
          if (probe.allowed) {
            // 部分迭代制造失败，驱动熔断器 closed → open → half-open 状态迁移
            if (iteration % 3 === 0) benchBreakers.recordFailure(key);
            else benchBreakers.recordSuccess(key);
          }
          for (let attempt = 1; attempt <= 4; attempt += 1) backoffDelayMs(attempt);
          classifyError(new TimeoutError('bench timeout'));
          classifyError(Object.assign(new Error('bench rate limited'), { status: 429 }));
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
      teardown: () => benchBreakers.reset(),
    });

    // ── sync：双节点变更登记 + 增量批次 + 对端幂等应用（离线，真实模块） ──
    const syncNodeA = new DistributedSync(
      'bench-node-a',
      memory,
      path.join(os.tmpdir(), `dsh-bench-sync-a-${benchStamp}.json`),
      null,
    );
    const syncMemB = new LongTermMemory(path.join(os.tmpdir(), `dsh-bench-sync-memb-${benchStamp}.json`));
    const syncNodeB = new DistributedSync(
      'bench-node-b',
      syncMemB,
      path.join(os.tmpdir(), `dsh-bench-sync-b-${benchStamp}.json`),
      null,
    );
    this.registerScenario({
      name: 'sync-batch-roundtrip',
      description: '分布式同步：变更登记 + 增量批次创建 + 对端哈希校验/幂等应用',
      target: 'sync',
      concurrency: 2,
      totalRequests: 200,
      warmupRequests: 20,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          syncNodeA.recordChange('feedback-created', `bench-fb-${iteration}`, {
            id: `bench-fb-${iteration}`,
            timestamp: Date.now(),
            signalType: 'benchmark-sync',
            signalDescription: `sync-${iteration}`,
            decision: 'execute',
            outcome: 'good',
            outcomeReason: 'benchmark synthetic',
          });
          const batch = syncNodeA.createBatch('bench-node-b');
          if (batch) {
            const result = await syncNodeB.receiveBatch(batch);
            if (result.errors.length > 0) {
              return { success: false, latency: Date.now() - startedAt, error: result.errors[0] };
            }
            syncNodeA.acknowledgePeer('bench-node-b', batch.logicalClock);
          }
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
      teardown: () => {
        syncNodeA.stop();
        syncNodeB.stop();
      },
    });

    // ── consensus：单节点 Raft 提案-提交压测（离线，真实模块；端口随机防冲突） ──
    const raftEngine = new RaftEngine({
      localNodeId: 'bench-raft-node',
      cluster: [],
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50,
      consensusPort: 25_000 + Math.floor(Math.random() * 20_000),
      logPath: path.join(os.tmpdir(), `dsh-bench-raft-${benchStamp}.json`),
    });
    let raftStarted = false;
    this.registerScenario({
      name: 'consensus-single-node-propose',
      description: '共识引擎：单节点集群提案 → 日志追加 → 多数派（自身）提交',
      target: 'consensus',
      concurrency: 1,
      totalRequests: 100,
      warmupRequests: 10,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          if (!raftStarted) {
            raftEngine.start(); // 单节点集群启动即成为 leader
            raftStarted = true;
          }
          const result = await raftEngine.propose(
            {
              type: 'execute-plan',
              signalId: `bench-sig-${iteration}`,
              signalDescription: `consensus bench ${iteration}`,
              decision: null,
              proposedBy: 'bench-raft-node',
            },
            3000,
          );
          return {
            success: result.committed,
            latency: Date.now() - startedAt,
            error: result.committed ? undefined : '提案未提交',
          };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
      teardown: () => {
        raftEngine.stop();
      },
    });

    // ── strategist：决策模型调用压测（需要 callLLM） ──
    this.registerScenario({
      name: 'strategist-decision',
      description: '战略决策模型调用延迟与成功率',
      target: 'strategist',
      concurrency: 2,
      totalRequests: 10,
      warmupRequests: 1,
      timeout: 60000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        if (typeof callLLM !== 'function') {
          return { success: false, latency: 0, error: 'skipped: callLLM 未提供' };
        }
        try {
          await Promise.race([
            callLLM({ task: `benchmark-decision-${iteration}`, models }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
          ]);
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // ── full-pipeline：端到端链路压测（需要 callLLM） ──
    this.registerScenario({
      name: 'full-pipeline-e2e',
      description: '信号 → 决策 → 计划 → 执行 → 沉淀全链路',
      target: 'full-pipeline',
      concurrency: 1,
      totalRequests: 5,
      warmupRequests: 0,
      timeout: 120000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        if (typeof callLLM !== 'function') {
          return { success: false, latency: 0, error: 'skipped: callLLM 未提供' };
        }
        try {
          await callLLM({ task: `benchmark-pipeline-${iteration}`, models });
          memory.recordDecisionFeedback({
            signalType: 'benchmark-pipeline',
            signalDescription: `e2e-${iteration}`,
            decision: 'execute',
            outcome: 'good',
            outcomeReason: 'benchmark synthetic',
          });
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  /**
   * 执行单个场景
   * @param scenario 场景定义
   * @param onProgress 进度回调 (done, total)
   */
  async runScenario(
    scenario: BenchmarkScenario,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{
    stats: BenchmarkStats;
    latencyDistribution: Array<{ bucket: string; count: number }>;
    passed: boolean;
    thresholdViolations: string[];
  }> {
    const total = scenario.totalRequests + scenario.warmupRequests;
    const latencies: number[] = [];
    const errors: Record<string, number> = {};
    let successCount = 0;
    let failCount = 0;
    let done = 0;
    let peakMemoryMB = 0;

    // 高精度计时：Date.now() 整毫秒在亚毫秒负载下差值为 0，吞吐被误判为 0
    const startedAt = performance.now();
    let cursor = 0;

    // 并发池 worker
    const worker = async (): Promise<void> => {
      while (cursor < total) {
        const iteration = cursor++;
        // 预热在前：前 warmupRequests 次迭代为 JIT/缓存预热，不计入
        // 统计——预热放末尾会让被测段恰为冷启动，p95/p99 虚高
        const isWarmup = iteration < scenario.warmupRequests;
        let result: BenchmarkResult;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race<BenchmarkResult>([
            scenario.execute(iteration),
            new Promise<BenchmarkResult>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error(`scenario timeout after ${scenario.timeout}ms`)), scenario.timeout);
            }),
          ]);
        } catch (err) {
          result = { success: false, latency: 0, error: err instanceof Error ? err.message : String(err) };
        } finally {
          clearTimeout(timeoutId); // 成功路径及时清 timer，防海量悬挂定时器
        }

        if (!isWarmup) {
          if (result.success) {
            successCount += 1;
            latencies.push(result.latency);
          } else {
            failCount += 1;
            const key = result.error ?? 'unknown';
            errors[key] = (errors[key] ?? 0) + 1;
          }
        }
        done += 1;
        const mem = process.memoryUsage();
        peakMemoryMB = Math.max(peakMemoryMB, mem.heapUsed / 1024 / 1024);
        onProgress?.(done, total);
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, scenario.concurrency) }, () => worker()));
    const totalDuration = performance.now() - startedAt;

    // 场景资源回收（失败不阻断报告生成）
    try {
      await scenario.teardown?.();
    } catch {
      /* teardown 失败忽略 */
    }

    const stats = this.computeStats(latencies, successCount, failCount, errors, totalDuration, peakMemoryMB);
    const latencyDistribution = this.buildDistribution(latencies);
    const thresholdViolations = this.checkThresholds(scenario.target, stats);

    return {
      stats,
      latencyDistribution,
      passed: thresholdViolations.length === 0,
      thresholdViolations,
    };
  }

  /**
   * 执行全部已注册场景并生成报告（自动持久化）
   * @param onProgress 进度回调 (scenarioName, done, total)
   */
  async runAll(onProgress?: (scenarioName: string, done: number, total: number) => void): Promise<BenchmarkReport> {
    const startedAt = Date.now();
    const report: BenchmarkReport = {
      id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: os.cpus().length,
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        pluginVersion: PLUGIN_VERSION,
      },
      scenarios: [],
      overallPassed: true,
      totalDuration: 0,
    };

    for (const scenario of this.scenarios.values()) {
      const { stats, latencyDistribution, passed, thresholdViolations } = await this.runScenario(scenario, (done, total) =>
        onProgress?.(scenario.name, done, total),
      );
      report.scenarios.push({
        name: scenario.name,
        description: scenario.description,
        target: scenario.target,
        concurrency: scenario.concurrency,
        stats,
        passed,
        thresholdViolations,
        latencyDistribution,
      });
      if (!passed) report.overallPassed = false;
    }

    // 45.0：OCBA 瓶颈聚焦（挂载时附加）——下一轮基准预算「砸给谁」
    // 从均匀升级为最优计算预算分配：差距大的场景早停，不确定是否最差
    // 的场景多跑（P(CS) 指数衰减率最优，Glynn–Juneja）。纯报告口径。
    if (this.ocbaAllocator && report.scenarios.length >= 2) {
      // 瓶颈确认口径：找出「最大均值延迟」的场景——biggerIsBetter=true
      //（确认对象 = 最大值），σ 由 p95−均值差近似
      const plan = ocbaAllocate(
        report.scenarios.map((s) => ({ name: s.name, mean: s.stats.avgLatency, std: Math.sqrt(Math.max(1e-6, s.stats.p95Latency - s.stats.avgLatency)) })),
        this.ocbaAllocator.confirmationBudget,
        { biggerIsBetter: true },
      );
      const worst = report.scenarios[plan.best];
      report.bottleneckFocus = {
        candidate: worst ? worst.name : undefined,
        rationale: worst
          ? `延迟最高场景 ${worst.name}（均值 ${Math.round(worst.stats.avgLatency)}ms）——下一轮确认预算 ${this.ocbaAllocator.confirmationBudget} 次 OCBA 分配：${report.scenarios.map((s, i) => `${s.name}:${plan.counts[i]}`).join(' / ')}`
          : undefined,
        allocation: report.scenarios.map((s, i) => ({ name: s.name, count: plan.counts[i] })),
      };
    }

    // 73.0：BAI 引擎锦标赛（挂载时附加）——「选型阶段」的冠军裁决。
    // 臂 = 场景（μ = 归一化成功率），successiveHalving 逐轮减半锁定
    // 最佳臂（预算 ≳ 2H·log K 口径由 hComplexity 预读）；并列/近并列
    // （H → ∞）时信息论上分不出冠军——诚实报告并列、不硬选。
    // 纯报告口径（与 45.0 OCBA 附加位并列），不改变场景执行（零漂移）。
    if (this.baiSelector && report.scenarios.length >= 2) {
      const mus = report.scenarios.map((s) => Math.max(0, Math.min(1, s.stats.successRate)));
      const bai = successiveHalving({ mus, budget: this.baiSelector.budget, seed: 20261001 });
      const complexity = hComplexity(mus);
      const winner = report.scenarios[bai.best];
      report.baiFocus = {
        recommended: winner ? winner.name : undefined,
        rationale:
          winner && complexity.H < Number.POSITIVE_INFINITY
            ? `锦标赛冠军 ${winner.name}（SH ${bai.rounds} 轮，样本分配 ${bai.samplesPerArm.join('/')}，Σ ≤ ${this.baiSelector.budget}；H=${complexity.H.toFixed(0)} → 下轮预算 ≥ ${Math.ceil(2 * complexity.H * Math.log(mus.length))}）`
            : `并列最优（H = ∞）：${report.scenarios.filter((_, i) => mus[i] === Math.max(...mus)).map((s) => s.name).join(' / ')} 信息论上分不出冠军——保留全部并列者交运行时口径（21.0/31.0）混合调度`,
        samplesPerArm: bai.samplesPerArm,
        rounds: bai.rounds,
        hComplexity: complexity.H,
      };
    }

    // 第三轮 A15：e-过程回归告警（挂载时附加）——逐场景成功率作为质量
    // 分进资本过程：H0: μ ≥ baseline，e_t = Π(1 + λ(x − baseline)) 累积
    // 「低于基线」证据，e ≥ 1/α 报警。任意时刻读取合法（Ville 上界）——
    // 基线分数流可边跑边看，不需要预先定死样本量。纯观测口径零漂移。
    if (this.regressionDetector) {
      for (const s of report.scenarios) {
        this.regressionDetector.observe(s.stats.successRate);
      }
      report.regressionAlarm = this.regressionDetector.view();
    }

    // 第四轮 R4-A15：长期基准追踪（挂载时附加）——逐场景成功率滚动存档，
    // 趋势斜率（Theil–Sen 稳健中位斜率）+ Mann–Kendall 非参显著性 +
    // 「最近 N 次均值 vs 历史基线」Mann–Whitney 对照。分数漂移检测对单点
    // 噪声稳健（斜率取全对斜率中位数、检验非参），平稳流在 α 纪律下零误报。
    // 纯报告附加口径，不改变场景执行本身（缺省零漂移）。
    if (this.trendTracker) {
      for (const s of report.scenarios) {
        this.trendTracker.record(s.name, s.stats.successRate, report.timestamp);
      }
      report.trendTracking = { timestamp: report.timestamp, series: this.trendTracker.views() };
    }

    // 第三轮 A15：下一轮跑分预算计划（对接 73.0 BAI 挂载视图）——
    // attachBaiSelector 则逐次减半锦标赛聚焦（难分臂多样本、悬殊臂
    // 早停；自实现对齐 73.0 口径），否则均匀分配。纯计划口径零漂移。
    report.budgetPlan = this.planBenchmarkBudget({
      scores: report.scenarios.map((s) => ({ name: s.name, score: s.stats.successRate })),
    });

    report.totalDuration = Date.now() - startedAt;
    this.saveReport(report);
    return report;
  }

  /**
   * 73.0：挂载最佳臂识别选择器（幂等覆盖，挂载即生效——纯报告附加）。
   *
   * runAll 结束时以各场景成功率为臂均值跑 successiveHalving 锦标赛，
   * 冠军与样本分配附在报告 baiFocus；不改变场景执行本身（零漂移）。
   */
  attachBaiSelector(options?: { budget?: number }): void {
    this.baiSelector = { budget: Math.max(10, Math.floor(options?.budget ?? 120)) };
  }

  private baiSelector?: { budget: number };

  /**
   * 93.0：挂载 Hyperband 配置寻优器（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 与 73.0 BAI 的分工：BAI 选离散臂（「哪个引擎是冠军」）、每臂一次性
   * 全量评估；本内核管连续配置空间 × 可提前终止的全预算曲线（「哪组
   * 超参最强」）。evaluate(config, budget) 须确定性且分数随 budget 单调
   * 不减（学习曲线族天然满足）——预算审计 totalBudgetSpent ===
   * schedule.totalBudget 可对账沙盒成本。不改变场景执行本身（零漂移）。
   */
  attachHyperbandTuner(options?: { eta?: number; seed?: number }): void {
    this.hyperbandTuner = { eta: options?.eta ?? 3, seed: options?.seed ?? 1 };
  }

  /** 93.0：Hyperband 寻优配置（未挂载 undefined） */
  private hyperbandTuner?: { eta: number; seed: number };

  /**
   * 93.0：Hyperband 配置寻优（未挂载 / 配置非法时 undefined）。
   * @param configs 配置源（列表或 (rng) => config 工厂）
   * @param evaluate 同一 (config, budget) 确定性、分数随 budget 单调不减
   * @param maxBudget 单配置最大预算 R ≥ 1（1 单位 = 1 条评测 prompt / epoch）
   */
  hyperbandTune<T>(
    configs: ConfigSource<T>,
    evaluate: (config: T, budget: number) => number,
    maxBudget: number,
  ): HyperbandResult<T> | undefined {
    return this.hyperbandTuner
      ? hyperbandTune<T>(configs, evaluate, { maxBudget, eta: this.hyperbandTuner.eta, seed: this.hyperbandTuner.seed })
      : undefined;
  }

  // ─────────────── 第三轮 A15：回归检测 / 预算聚焦 / 结构化导出 ───────────────

  /**
   * 第三轮 A15：挂载 e-过程回归检测器（幂等覆盖，挂载即生效——纯观测口径）。
   *
   * runAll 结束时逐场景成功率作为质量分进资本过程；也可由宿主经
   * observeBenchmarkScore 手动喂任意分数流（如逐窗口成功率）。累积证据
   * e ≥ 1/α 报警（Ville 不等式：任意时刻、含持续偷看下误报率 ≤ α——
   * 对齐 12.0 任意时刻证据思想自实现）。不改变场景执行本身（零漂移）。
   */
  attachRegressionDetector(options: { baseline: number; alpha?: number }): void {
    this.regressionDetector = new BenchmarkRegressionDetector(options);
  }

  /** 第三轮 A15：回归检测器（未挂载 undefined） */
  private regressionDetector?: BenchmarkRegressionDetector;

  // ─────────────── 第四轮 R4-A15：长期追踪 / 模型推荐 ───────────────

  /**
   * 第四轮 R4-A15：挂载长期基准追踪器（幂等覆盖，挂载即生效——纯报告附加）。
   *
   * runAll 结束时逐场景成功率滚动存档（每场景一条分数历史序列，
   * maxHistory 截断），报告附 trendTracking：Theil–Sen 稳健斜率 +
   * Mann–Kendall 趋势显著性 + 最近 windowSize 次均值 vs 历史基线的
   * Mann–Whitney 对照。也可经 recordTrendPoint 手动喂任意「模型→分数」
   * 流。不改变场景执行本身（缺省零漂移）。
   */
  attachTrendTracker(options?: { windowSize?: number; maxHistory?: number; alpha?: number; now?: () => number }): void {
    this.trendTracker = new BenchmarkTrendTracker(options);
  }

  /** 第四轮 R4-A15：长期追踪器（未挂载 undefined） */
  private trendTracker?: BenchmarkTrendTracker;

  /**
   * 手动喂一条长期追踪分数（挂载时记录并返回该序列趋势视图）。
   * @param name 序列名（模型 id / 场景名）
   * @param score 分数（任意实数——成功率 / 质量分 / 延迟均可，斜率与检验非参）
   * @param timestamp 可选时间戳（缺省用注入时钟——确定性口径）
   */
  recordTrendPoint(name: string, score: number, timestamp?: number): TrendSeriesView | undefined {
    return this.trendTracker?.record(name, score, timestamp);
  }

  /** 全部序列趋势视图（未挂载 / 无记录 → 空数组；按序列名升序） */
  trendSeriesViews(): TrendSeriesView[] {
    return this.trendTracker?.views() ?? [];
  }

  /**
   * 第四轮 R4-A15：挂载模型推荐引擎（幂等覆盖，挂载即生效——纯咨询口径）。
   *
   * 历史表由 recordModelOutcome / ingestModelOutcomes 累积（任务特征 ×
   * 模型 → 分数），recommendModel 按特征查表 + 反距离加权插值；未知特征
   * 诚实回退全局最优。纯咨询：不影响场景执行与报告判定（零漂移）。
   */
  attachRecommender(options?: { radius?: number; rollingWindow?: number }): void {
    this.recommender = new BenchmarkRecommender(options);
  }

  /** 第四轮 R4-A15：模型推荐引擎（未挂载 undefined） */
  private recommender?: BenchmarkRecommender;

  /**
   * 按任务特征推荐模型（未挂载 / 无历史 → undefined——诚实缺席）。
   * @param features 任务特征（类型 / 复杂度 ∈ [0,1] / 预算）
   */
  recommendModel(features: TaskFeatureProfile): RecommendationView | undefined {
    return this.recommender?.recommend(features);
  }

  /**
   * 登记一条推荐结果对照（推荐命中与否滚动统计的喂入口）。
   * @param actualBest 该任务事后实测最优模型（held-out 真值）
   */
  recordRecommendationOutcome(
    features: TaskFeatureProfile,
    recommendedModelId: string,
    actualBestModelId: string,
  ): { hit: boolean } & RecommendationHitStats | undefined {
    return this.recommender?.recordOutcome(features, recommendedModelId, actualBestModelId);
  }

  /** 推荐命中率读数（未挂载 → undefined；纯读取） */
  recommendationHitStats(): RecommendationHitStats | undefined {
    return this.recommender?.hitStats();
  }

  /** 登记一条「任务特征 × 模型 → 分数」历史（挂载推荐引擎时生效） */
  recordModelOutcome(record: ModelOutcomeRecord): void {
    this.recommender?.record(record);
  }

  /**
   * 第三轮 A15：喂一条基准质量分（挂载时累积证据并返回当前告警视图）。
   * @param score 质量分 ∈ [0,1]（如窗口成功率 / 归一化质量分；越界截断）
   */
  observeBenchmarkScore(score: number): RegressionAlarmView | undefined {
    return this.regressionDetector?.observe(score);
  }

  /** 第三轮 A15：回归告警读数（纯读取，不改变状态；未挂载 undefined） */
  regressionAlarmView(): RegressionAlarmView | undefined {
    return this.regressionDetector?.view();
  }

  /**
   * 第三轮 A15：下一轮跑分预算计划（对接已挂载的 73.0 BAI 视图）。
   *
   * - attachBaiSelector 已挂载 → bai-focus：以基线分数为臂均值的逐次减半
   *   锦标赛（自实现对齐 73.0 SH 口径：每轮存活臂均分 budget/(R·|A_r|)，
   *   只留累计经验均值前半，平手小下标优先）——同预算下识别率 ≥ 均匀
   *   （见 scripts/verify-mod-bench-dash.mjs 锚点）；
   * - 未挂载 → uniform：每臂 ⌊budget/K⌋ 均摊（诚实基线，不假装聚焦）。
   *
   * 纯计划口径：只产出分配建议，不改变本轮任何执行（零漂移）。
   */
  planBenchmarkBudget(options?: {
    scores?: ReadonlyArray<{ name: string; score: number }>;
    budget?: number;
    seed?: number;
  }): BenchmarkBudgetPlan {
    const scores = options?.scores ?? [];
    const seed = options?.seed ?? 20261002;
    if (scores.length === 0) {
      return {
        strategy: 'uniform',
        totalBudget: 0,
        allocation: [],
        recommended: undefined,
        rationale: '无基线分数——下一轮跑分预算暂不分配（先跑一轮产出基线）',
      };
    }
    const budget = Math.max(scores.length, Math.floor(options?.budget ?? this.baiSelector?.budget ?? 120));
    const mus = scores.map((s) => clampUnit(s.score));
    const focused = this.baiSelector !== undefined;
    const plan = focused
      ? baiFocusedBudgetAllocation(mus, budget, seed)
      : uniformBudgetAllocation(mus, budget, seed);
    const allocation = scores.map((s, i) => ({ name: s.name, count: plan.samplesPerArm[i] ?? 0 }));
    const recommended = scores[plan.best]?.name;
    return {
      strategy: focused ? 'bai-focus' : 'uniform',
      totalBudget: budget,
      allocation,
      recommended,
      rationale: focused
        ? `73.0 BAI 聚焦（SH ${plan.rounds} 轮锦标赛，同预算识别率 ≥ 均匀）：${allocation.map((a) => `${a.name}:${a.count}`).join(' / ')}——难分臂多样本、悬殊臂早停；推荐下轮冠军 ${recommended ?? '—'}`
        : `均匀分配（未挂载 attachBaiSelector）：每场景 ⌊${budget}/${scores.length}⌋ 次均摊——挂载后切换 SH 锦标赛聚焦`,
    };
  }

  /**
   * 第三轮 A15：结构化报告导出（JSON 就绪：分数 + CI + 检验结论 + 建议）。
   *
   * @param report 待导出的基准报告（通常为 runAll 返回值）
   * @param extras 可选成对检验输入——对同一任务流的两组分数流跑
   *   符号检验 + 自助 CI，结论附在 pairwise 字段（机器可读的显著性口径）
   */
  exportStructuredReport(
    report: BenchmarkReport,
    extras?: {
      pairwise?: ReadonlyArray<{
        aName: string;
        aScores: ReadonlyArray<number>;
        bName: string;
        bScores: ReadonlyArray<number>;
        alpha?: number;
        iterations?: number;
        seed?: number;
      }>;
    },
  ): StructuredBenchmarkReport {
    const scenarios: StructuredScenarioSummary[] = report.scenarios.map((s) => ({
      name: s.name,
      target: s.target,
      passed: s.passed,
      score: round3(s.stats.successRate),
      avgLatency: round3(s.stats.avgLatency),
      p95Latency: round3(s.stats.p95Latency),
      p99Latency: round3(s.stats.p99Latency),
      throughput: round3(s.stats.throughput),
      thresholdViolations: [...s.thresholdViolations],
    }));
    const pairwise = (extras?.pairwise ?? []).map((p) =>
      pairedModelComparison(p.aName, p.aScores, p.bName, p.bScores, {
        alpha: p.alpha,
        iterations: p.iterations,
        seed: p.seed,
      }),
    );
    const suggestions: string[] = [];
    for (const s of scenarios) {
      if (s.thresholdViolations.length > 0) suggestions.push(`修复阈值违反：${s.name}——${s.thresholdViolations.join('；')}`);
    }
    if (report.regressionAlarm?.alarm) suggestions.push(`回归告警已确证：${report.regressionAlarm.insight}`);
    // 第四轮 R4-A15：长期追踪漂移检出 → 可执行行动项（仅在挂载追踪器时出现）
    const drifted = report.trendTracking?.series.filter((s) => s.driftDetected) ?? [];
    if (drifted.length > 0) {
      suggestions.push(
        `长期追踪漂移检出：${drifted.map((s) => `${s.name}（斜率 ${s.slope.toFixed(4)}/步，${s.insight}）`).join('；')}——回溯该序列存档定位变更窗口`,
      );
    }
    if (report.baiFocus?.recommended) suggestions.push(`选型确认：冠军 ${report.baiFocus.recommended}（${report.baiFocus.rationale ?? ''}）`);
    if (report.bottleneckFocus?.candidate) suggestions.push(`瓶颈确认：${report.bottleneckFocus.candidate}（下一轮 OCBA 确认预算见 bottleneckFocus.allocation）`);
    if (pairwise.length > 0) suggestions.push(`成对检验：${pairwise.map((p) => p.conclusion).join('；')}`);
    if (report.budgetPlan) suggestions.push(`下一轮跑分预算（${report.budgetPlan.strategy}）：${report.budgetPlan.rationale}`);
    if (suggestions.length === 0) suggestions.push('全部场景在阈值内且无回归证据——维持现状，按 budgetPlan 安排下一轮');
    return {
      reportId: report.id,
      timestamp: report.timestamp,
      overallPassed: report.overallPassed,
      scenarios,
      pairwise,
      regression: report.regressionAlarm,
      budgetPlan: report.budgetPlan,
      baiFocus: report.baiFocus,
      bottleneckFocus: report.bottleneckFocus,
      /** 第四轮 R4-A15：长期追踪快照回显（未挂载 undefined） */
      trendTracking: report.trendTracking,
      suggestions,
    };
  }

  /**
   * 45.0：挂载 OCBA 预算分配器（幂等覆盖，挂载即生效——纯报告附加）。
   *
   * runAll 结束时以各场景延迟统计为试点，给出「确认瓶颈子系统」的
   * OCBA 最优重跑预算分配（P(CS) 渐近最优）附在报告 bottleneckFocus；
   * 不改变场景执行本身（零漂移）。
   */
  attachOcbaAllocator(options?: { confirmationBudget?: number }): void {
    this.ocbaAllocator = { confirmationBudget: Math.max(10, Math.floor(options?.confirmationBudget ?? 200)) };
  }

  private ocbaAllocator?: { confirmationBudget: number };

  /** 加载全部历史报告（按时间倒序） */
  loadReports(): BenchmarkReport[] {
    if (!fs.existsSync(this.reportDir)) return [];
    const files = fs.readdirSync(this.reportDir).filter((f) => f.endsWith('.json'));
    const reports: BenchmarkReport[] = [];
    for (const file of files) {
      try {
        reports.push(JSON.parse(fs.readFileSync(path.join(this.reportDir, file), 'utf-8')));
      } catch {
        /* 跳过损坏报告 */
      }
    }
    return reports.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 对比两份报告，输出逐场景变化（用于性能回归检测）
   * @param beforeId 基线报告 id
   * @param afterId 新报告 id
   */
  compareReports(beforeId: string, afterId: string): string {
    const reports = this.loadReports();
    const before = reports.find((r) => r.id === beforeId);
    const after = reports.find((r) => r.id === afterId);
    if (!before || !after) {
      throw new AppError(`报告不存在: before=${beforeId}, after=${afterId}`, 'BENCHMARK_ERROR');
    }

    const lines: string[] = [
      `# 基准对比报告`,
      `- 基线: ${before.id} (${new Date(before.timestamp).toISOString()})`,
      `- 当前: ${after.id} (${new Date(after.timestamp).toISOString()})`,
      '',
    ];

    for (const afterScenario of after.scenarios) {
      const beforeScenario = before.scenarios.find((s) => s.name === afterScenario.name);
      if (!beforeScenario) {
        lines.push(`## ${afterScenario.name} — 新增场景（无基线）`);
        continue;
      }
      const b = beforeScenario.stats;
      const a = afterScenario.stats;
      const delta = (prev: number, curr: number): string => {
        if (prev === 0) return curr === 0 ? '0%' : '+∞';
        const pct = ((curr - prev) / prev) * 100;
        return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      };
      lines.push(
        `## ${afterScenario.name} [${afterScenario.target}]`,
        `- p95 延迟: ${b.p95Latency}ms → ${a.p95Latency}ms (${delta(b.p95Latency, a.p95Latency)})`,
        `- p99 延迟: ${b.p99Latency}ms → ${a.p99Latency}ms (${delta(b.p99Latency, a.p99Latency)})`,
        `- 吞吐率: ${b.throughput.toFixed(2)} → ${a.throughput.toFixed(2)} req/s (${delta(b.throughput, a.throughput)})`,
        `- 成功率: ${(b.successRate * 100).toFixed(2)}% → ${(a.successRate * 100).toFixed(2)}%`,
        `- 判定: ${beforeScenario.passed ? 'PASS' : 'FAIL'} → ${afterScenario.passed ? 'PASS' : 'FAIL'}`,
        '',
      );
    }
    return lines.join('\n');
  }

  /**
   * 生成 Markdown 格式报告
   */
  generateMarkdownReport(report: BenchmarkReport): string {
    const lines: string[] = [
      `# 基准测试报告 ${report.id}`,
      '',
      `> ${new Date(report.timestamp).toISOString()} | Node ${report.environment.nodeVersion} | ${report.environment.platform}/${report.environment.arch} | ${report.environment.cpuCount} CPU | ${report.environment.totalMemoryMB}MB RAM`,
      '',
      `**总体判定: ${report.overallPassed ? '✅ PASS' : '❌ FAIL'}** | 总耗时 ${(report.totalDuration / 1000).toFixed(1)}s`,
      '',
      `| 场景 | target | 并发 | 请求数 | 成功率 | avg | p95 | p99 | 吞吐(req/s) | 判定 |`,
      `|------|--------|------|--------|--------|-----|-----|-----|-------------|------|`,
    ];
    for (const s of report.scenarios) {
      lines.push(
        `| ${s.name} | ${s.target} | ${s.concurrency} | ${s.stats.totalRequests} | ${(s.stats.successRate * 100).toFixed(2)}% | ${s.stats.avgLatency.toFixed(1)}ms | ${s.stats.p95Latency.toFixed(1)}ms | ${s.stats.p99Latency.toFixed(1)}ms | ${s.stats.throughput.toFixed(2)} | ${s.passed ? '✅' : '❌'} |`,
      );
    }
    lines.push('');
    for (const s of report.scenarios) {
      if (s.thresholdViolations.length > 0) {
        lines.push(`### ⚠️ ${s.name} 阈值违反`, ...s.thresholdViolations.map((v) => `- ${v}`), '');
      }
      if (Object.keys(s.stats.errorDistribution).length > 0) {
        lines.push(`### ❌ ${s.name} 错误分布`);
        for (const [err, count] of Object.entries(s.stats.errorDistribution)) {
          lines.push(`- ${err}: ${count} 次`);
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 计算聚合统计 */
  private computeStats(
    latencies: number[],
    successCount: number,
    failCount: number,
    errors: Record<string, number>,
    totalDuration: number,
    peakMemoryMB: number,
  ): BenchmarkStats {
    const total = successCount + failCount;
    const sorted = [...latencies].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[Math.max(0, index)]!;
    };
    const avg = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const variance = sorted.length > 0 ? sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / sorted.length : 0;

    return {
      totalRequests: total,
      successCount,
      failCount,
      successRate: total > 0 ? successCount / total : 0,
      minLatency: sorted[0] ?? 0,
      maxLatency: sorted[sorted.length - 1] ?? 0,
      avgLatency: avg,
      p50Latency: percentile(50),
      p90Latency: percentile(90),
      p95Latency: percentile(95),
      p99Latency: percentile(99),
      stdDev: Math.sqrt(variance),
      throughput: totalDuration > 0 ? (total / totalDuration) * 1000 : 0,
      totalDuration,
      peakMemoryMB: Math.round(peakMemoryMB * 100) / 100,
      errorDistribution: errors,
    };
  }

  /** 构建延迟分布直方图 */
  private buildDistribution(latencies: number[]): Array<{ bucket: string; count: number }> {
    const distribution = LATENCY_BUCKETS.map((b) => ({ bucket: b.bucket, count: 0 }));
    for (const latency of latencies) {
      const bucketIndex = LATENCY_BUCKETS.findIndex((b) => latency < b.max);
      distribution[bucketIndex >= 0 ? bucketIndex : LATENCY_BUCKETS.length - 1]!.count += 1;
    }
    return distribution;
  }

  /** 阈值门禁检查 */
  private checkThresholds(target: BenchmarkScenario['target'], stats: BenchmarkStats): string[] {
    const threshold = this.thresholds[target] ?? DEFAULT_THRESHOLDS[target]!;
    const violations: string[] = [];
    // 全部失败（如 skipped 场景）不触发延迟类阈值，仅记录成功率问题
    if (stats.totalRequests === 0) return violations;
    if (stats.p95Latency > threshold.maxP95Latency) {
      violations.push(`p95 延迟 ${stats.p95Latency.toFixed(1)}ms 超过阈值 ${threshold.maxP95Latency}ms`);
    }
    if (stats.p99Latency > threshold.maxP99Latency) {
      violations.push(`p99 延迟 ${stats.p99Latency.toFixed(1)}ms 超过阈值 ${threshold.maxP99Latency}ms`);
    }
    if (stats.throughput < threshold.minThroughput) {
      violations.push(`吞吐率 ${stats.throughput.toFixed(2)} req/s 低于阈值 ${threshold.minThroughput} req/s`);
    }
    if (stats.successRate < threshold.minSuccessRate) {
      violations.push(`成功率 ${(stats.successRate * 100).toFixed(2)}% 低于阈值 ${(threshold.minSuccessRate * 100).toFixed(2)}%`);
    }
    return violations;
  }

  /** 持久化报告 */
  private saveReport(report: BenchmarkReport): void {
    fs.mkdirSync(this.reportDir, { recursive: true });
    const filePath = path.join(this.reportDir, `${report.id}.json`);
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 第三轮 A15：成对统计检验 / e-过程回归检测器 / BAI 聚焦预算分配
// （纯函数与独立类——引擎方法之上的数学层；全部自实现，不 import
//   98 内核——口径对齐 12.0 任意时刻证据与 73.0 最佳臂识别思想）
// ═══════════════════════════════════════════════════════════════════

/** 截断到 [0,1]（质量分 / 成功率归一口径） */
function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** 3 位小数舍入（导出口径的可读性） */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** 文件内确定性 RNG（mulberry32）——同种子同序列（种子化自助重采样） */
function benchRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 二项精确双侧 p-值：X ~ Bin(n, 0.5)，p = min(1, 2·P(X ≤ min(k, n−k)))。
 * 符号检验零假设下胜负各 1/2——小样本也精确（不依赖正态近似）。
 */
function signTestPValue(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let logTail = -n * Math.LN2;
  let logP = logTail;
  let total = Math.exp(logTail);
  for (let i = 1; i <= k; i += 1) {
    // P(X = i) = P(X = i-1) · (n - i + 1) / i（对数域递推，避免组合数溢出）
    logP += Math.log(n - i + 1) - Math.log(i);
    total += Math.exp(logP);
  }
  return Math.min(1, 2 * total);
}

// ─────────────────── 成对统计检验（点分 → 显著性 + CI） ───────────────────

/** 符号检验结果（配对分数流 A vs B——并列剔除口径） */
export interface PairedSignTestResult {
  /** 有效配对数（剔除并列后） */
  n: number;
  /** A > B 次数 */
  wins: number;
  /** A < B 次数 */
  losses: number;
  /** 并列（A = B）次数（剔除，不计入检验） */
  ties: number;
  /** 双侧精确二项 p-值 */
  pValue: number;
  /** p < alpha */
  significant: boolean;
  /** 显著时的方向（不显著时 'tie'） */
  direction: 'A-better' | 'B-better' | 'tie';
  alpha: number;
}

/**
 * 配对符号检验：同一任务流上两组分数的逐对比较——A 赢次数 vs B 赢次数。
 *
 * 零假设 H0: P(A > B) = 1/2（无差异）；并列剔除（零假设下并列概率与
 * 方向无关，剔除保持精确性）。小样本走精确二项（不做正态近似——
 * 基准对比常常只有十几对）。
 */
export function pairedSignTest(
  scoresA: ReadonlyArray<number>,
  scoresB: ReadonlyArray<number>,
  options?: { alpha?: number },
): PairedSignTestResult {
  const alpha = options?.alpha ?? 0.05;
  if (!Array.isArray(scoresA) || !Array.isArray(scoresB) || scoresA.length !== scoresB.length) {
    throw new AppError('pairedSignTest: 两组分数流须为等长数组', 'BENCHMARK_ERROR');
  }
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let i = 0; i < scoresA.length; i += 1) {
    const a = scoresA[i]!;
    const b = scoresB[i]!;
    if (a > b) wins += 1;
    else if (a < b) losses += 1;
    else ties += 1;
  }
  const pValue = signTestPValue(wins, losses);
  const significant = pValue < alpha;
  const direction: PairedSignTestResult['direction'] = !significant ? 'tie' : wins > losses ? 'A-better' : 'B-better';
  return { n: wins + losses, wins, losses, ties, pValue, significant, direction, alpha };
}

/** 种子化自助（bootstrap）差值置信区间 */
export interface PairedBootstrapCi {
  /** 观测差 mean(A) − mean(B) */
  observedDifference: number;
  /** 百分位置信下界（alpha/2 分位） */
  lower: number;
  /** 百分位置信上界（1 − alpha/2 分位） */
  upper: number;
  alpha: number;
  iterations: number;
  seed: number;
  /** CI 不含 0 → 差异非零（与符号检验互证） */
  excludesZero: boolean;
}

/**
 * 配对自助差值置信区间（种子化——同种子同区间，可复现审计）。
 *
 * 配对重采样：每次迭代抽 n 个下标（有放回），差值 = mean(A*) − mean(B*)
 * ——保持配对结构（同任务下的 A/B 相关性不被破坏）；percentile 法
 * 取双侧分位。回答「差异有多大概率不为零、量级落在哪」——点分之外
 * 的区间证据。
 */
export function bootstrapDifferenceCi(
  scoresA: ReadonlyArray<number>,
  scoresB: ReadonlyArray<number>,
  options?: { iterations?: number; alpha?: number; seed?: number },
): PairedBootstrapCi {
  if (!Array.isArray(scoresA) || !Array.isArray(scoresB) || scoresA.length !== scoresB.length || scoresA.length === 0) {
    throw new AppError('bootstrapDifferenceCi: 两组分数流须为非空等长数组', 'BENCHMARK_ERROR');
  }
  const n = scoresA.length;
  const iterations = Math.max(100, Math.floor(options?.iterations ?? 2000));
  const alpha = options?.alpha ?? 0.05;
  const seed = Math.floor(options?.seed ?? 20261002);
  const mean = (xs: ReadonlyArray<number>): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const observedDifference = mean(scoresA) - mean(scoresB);
  const rng = benchRng(seed);
  const diffs = new Array<number>(iterations);
  for (let it = 0; it < iterations; it += 1) {
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(rng() * n);
      sa += scoresA[idx]!;
      sb += scoresB[idx]!;
    }
    diffs[it] = sa / n - sb / n;
  }
  diffs.sort((a, b) => a - b);
  const q = (p: number): number => diffs[Math.min(iterations - 1, Math.max(0, Math.floor(p * iterations)))]!;
  const lower = q(alpha / 2);
  const upper = q(1 - alpha / 2);
  return {
    observedDifference,
    lower,
    upper,
    alpha,
    iterations,
    seed,
    excludesZero: lower > 0 || upper < 0,
  };
}

/** 成对模型对比完整裁决（符号检验 + 自助 CI + 中文结论） */
export interface PairedComparisonVerdict {
  a: string;
  b: string;
  n: number;
  observedDifference: number;
  signTest: PairedSignTestResult;
  bootstrap: PairedBootstrapCi;
  /** 机器可读 + 人可读的结论句 */
  conclusion: string;
}

/**
 * 成对模型对比（第三轮 A15 主口径）：同一任务流两组分数 →
 * 符号检验（方向 + 显著性）× 自助 CI（量级区间）。
 *
 * 「A 均值高 3 分」不再直接是结论——结论是「A 显著更优（p = 0.002，
 * 95% CI [0.8, 2.1]）」或「差异不显著（p = 0.32，CI [−1.2, 1.5] 含 0）」。
 */
export function pairedModelComparison(
  aName: string,
  aScores: ReadonlyArray<number>,
  bName: string,
  bScores: ReadonlyArray<number>,
  options?: { alpha?: number; iterations?: number; seed?: number },
): PairedComparisonVerdict {
  const signTest = pairedSignTest(aScores, bScores, { alpha: options?.alpha });
  const bootstrap = bootstrapDifferenceCi(aScores, bScores, {
    iterations: options?.iterations,
    alpha: options?.alpha,
    seed: options?.seed,
  });
  const pct = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(3);
  const conclusion =
    signTest.direction === 'tie'
      ? `${aName} vs ${bName}：差异不显著（p = ${signTest.pValue.toFixed(3)} ≥ α，95% CI [${bootstrap.lower.toFixed(3)}, ${bootstrap.upper.toFixed(3)}] 含 0）——点分差距不可作为结论`
      : `${aName} vs ${bName}：${signTest.direction === 'A-better' ? aName : bName} 显著更优（符号检验 p = ${signTest.pValue.toExponential(2)}，${signTest.wins}胜/${signTest.losses}负/${signTest.ties}平，95% CI [${bootstrap.lower.toFixed(3)}, ${bootstrap.upper.toFixed(3)}]，中心差 ${pct(bootstrap.observedDifference)}）`;
  return {
    a: aName,
    b: bName,
    n: signTest.n,
    observedDifference: bootstrap.observedDifference,
    signTest,
    bootstrap,
    conclusion,
  };
}

// ─────────────────── e-过程回归检测器（偷看免疫告警） ───────────────────

/** 回归告警读数（任意时刻读取合法——Ville 上界保证误报 ≤ α） */
export interface RegressionAlarmView {
  /** 基线均值 μ0（回归判定基准：质量分应 ≥ baseline） */
  baseline: number;
  /** 水平 α（e ≥ 1/α 报警） */
  alpha: number;
  /** 已观测样本数 */
  n: number;
  /** 当前 e-值（资本过程） */
  capital: number;
  /** 报警阈值 1/α */
  threshold: number;
  /** 累积证据超阈 → 回归确证 */
  alarm: boolean;
  /** 任意时刻有效 p-值 min(1, 1/e)（超均匀） */
  anytimeP: number;
  /** 样本均值（观测口径） */
  sampleMean: number;
  /** 历史峰值资本（证据曾到达多强） */
  peakCapital: number;
  /** 中文读数（告警 / 待观测） */
  insight: string;
}

/**
 * e-过程回归检测器（对齐 12.0 任意时刻证据思想自实现——不 import）。
 *
 * 检验 H0: μ ≥ μ0（质量不劣于基线）——回归 = 累积证据拒绝 H0：
 *   e_t = Π_{i≤t} (1 + λ_i (x_i − μ0))，λ_i 可预测（仅依赖 i−1 前
 *   的 EWMA 均值与基线的背离）、λ_i ∈ [−1/2, 0]、x ∈ [0,1] → 因子
 *   恒 ≥ 1/2 > 0。H0 下 E[1+λ(X−μ0) | 过去] = 1 + λ(μ−μ0) ≤ 1 →
 *   非负上鞅 → Ville 不等式：P(∃t: e_t ≥ 1/α) ≤ α——**任意时刻**
 *   （含每步都查、随时停）误报率 ≤ α，这就是「偷看免疫」：不需要预先
 *   定死样本量，边跑边看不膨胀假阳性（固定样本量检验反复查看会失去
 *   口径，e-过程不会）。真回归（μ < μ0）时 EWMA 均值快速跌落基线下
 *   （衰减 0.1——约 10 步跟上新状态，比累积均值快一个量级）→ λ < 0
 *   且 E[x−μ0] < 0 → 因子期望 > 1 → 资本指数累积 → 越阈报警。
 *   （λ 可为过去的任意有界函数——Ville 上界不依赖 λ 的具体形状；
 *   EWMA 只是让「下注」在变点后尽快到位。）
 */
export class BenchmarkRegressionDetector {
  /** EWMA 衰减（0.1 → ~10 步跟上状态迁移） */
  private static readonly EwmaDecay = 0.1;
  private capital = 1;
  private peak = 1;
  private n = 0;
  private mean = 0;
  private ewma: number | undefined;
  private readonly baselineValue: number;
  private readonly alphaValue: number;

  constructor(options: { baseline: number; alpha?: number }) {
    const baseline = options.baseline;
    const alpha = options.alpha ?? 0.05;
    if (!(baseline >= 0 && baseline <= 1)) {
      throw new AppError('BenchmarkRegressionDetector: baseline 须 ∈ [0,1]（质量分归一口径）', 'BENCHMARK_ERROR');
    }
    if (!(alpha > 0 && alpha < 1)) {
      throw new AppError('BenchmarkRegressionDetector: alpha 须 ∈ (0,1)', 'BENCHMARK_ERROR');
    }
    this.baselineValue = baseline;
    this.alphaValue = alpha;
  }

  /** 喂一条质量分 x ∈ [0,1]（越界截断）；返回更新后的告警视图 */
  observe(score: number): RegressionAlarmView {
    const x = clampUnit(score);
    // 可预测 λ：只看 i−1 前的 EWMA 均值与基线的背离，截断到 [−1/2, 0]
    //（H0: μ ≥ μ0 方向——均值低于基线才下注，λ ≤ 0）
    const prior = this.ewma;
    const lambda = prior === undefined ? 0 : Math.max(-0.5, Math.min(0, (prior - this.baselineValue) / 4));
    const factor = 1 + lambda * (x - this.baselineValue);
    this.capital *= Math.max(0.5, factor); // 因子下界保护（数学上恒 ≥ 0.5，冗余防御）
    this.peak = Math.max(this.peak, this.capital);
    this.n += 1;
    this.mean += (x - this.mean) / this.n;
    this.ewma = prior === undefined ? x : prior + BenchmarkRegressionDetector.EwmaDecay * (x - prior);
    return this.view();
  }

  /** 当前读数（纯读取，不改变状态） */
  view(): RegressionAlarmView {
    const threshold = 1 / this.alphaValue;
    const alarm = this.capital >= threshold;
    return {
      baseline: this.baselineValue,
      alpha: this.alphaValue,
      n: this.n,
      capital: round3(this.capital),
      threshold: round3(threshold),
      alarm,
      anytimeP: round3(Math.min(1, 1 / this.capital)),
      sampleMean: round3(this.mean),
      peakCapital: round3(this.peak),
      insight: alarm
        ? `回归确证：e = ${this.capital.toFixed(1)} ≥ 1/α = ${threshold.toFixed(1)}（n = ${this.n}，均值 ${this.mean.toFixed(3)} < 基线 ${this.baselineValue.toFixed(3)}）——累积证据越过阈值的概率在 H0 下 ≤ α = ${this.alphaValue}（任意时刻偷看免疫）`
        : `证据未越阈：e = ${this.capital.toFixed(2)} < 1/α = ${threshold.toFixed(1)}（n = ${this.n}，均值 ${this.mean.toFixed(3)} vs 基线 ${this.baselineValue.toFixed(3)}）——继续观测，无回归结论`,
    };
  }

  /** 已观测样本数 */
  get count(): number {
    return this.n;
  }

  /** 重置（新基线 / 新监测期） */
  reset(): void {
    this.capital = 1;
    this.peak = 1;
    this.n = 0;
    this.mean = 0;
    this.ewma = undefined;
  }
}

// ─────────────────── BAI 聚焦预算分配（73.0 口径自实现） ───────────────────

/** 预算分配锦标赛结果（SH / 均匀共形——识别率对照的公平口径） */
export interface BenchmarkAllocationPlan {
  /** 推荐臂下标（argmax 口径：并列取小下标） */
  best: number;
  /** 各臂样本数（Σ ≤ budget——预算纪律） */
  samplesPerArm: number[];
  /** 各臂经验均值（0 样本记 0） */
  empiricalMeans: number[];
  /** SH 减半轮数（均匀分配恒 0） */
  rounds: number;
}

/**
 * 逐次减半锦标赛分配（对齐 73.0 最佳臂识别口径自实现——不 import）。
 *
 * 臂均值 μ 已知口径下的预算分配模拟：R = ⌈log₂K⌉ 轮，每轮存活臂均分
 * 该轮配额 budget/(R·|A_r|)，只留累计经验均值前 ⌈|A_r|/2⌉（平手小下标
 * 优先——确定性）。存活越久配额越厚 → 样本自动流向小 gap 竞争者——
 * 与均匀分配相比，同预算识别率更高（难分臂拿到更多样本，悬殊臂早停）。
 */
export function baiFocusedBudgetAllocation(
  mus: ReadonlyArray<number>,
  budget: number,
  seed = 20261002,
): BenchmarkAllocationPlan {
  validateAllocationInputs(mus, budget);
  const rng = benchRng(seed);
  const K = mus.length;
  const samples = new Array<number>(K).fill(0);
  const successes = new Array<number>(K).fill(0);
  if (K === 1) {
    for (let i = 0; i < Math.floor(budget); i += 1) {
      samples[0]! += 1;
      successes[0]! += rng() < mus[0]! ? 1 : 0;
    }
    return { best: 0, samplesPerArm: samples, empiricalMeans: [successes[0]! / Math.max(1, samples[0]!)], rounds: 0 };
  }
  const rounds = Math.ceil(Math.log2(K));
  let alive = Array.from({ length: K }, (_, i) => i);
  let executedRounds = 0;
  for (let r = 0; r < rounds && alive.length > 1; r += 1) {
    const perArm = Math.floor(budget / (rounds * alive.length));
    if (perArm < 1) break; // 预算太小不足以分轮——已花样本上择优
    for (const i of alive) {
      for (let s = 0; s < perArm; s += 1) {
        samples[i]! += 1;
        successes[i]! += rng() < mus[i]! ? 1 : 0;
      }
    }
    executedRounds += 1;
    // 存活减半：经验均值降序，平手小下标优先（确定性）
    alive.sort((a, b) => {
      const ma = samples[a]! > 0 ? successes[a]! / samples[a]! : 0;
      const mb = samples[b]! > 0 ? successes[b]! / samples[b]! : 0;
      return mb - ma || a - b;
    });
    alive = alive.slice(0, Math.ceil(alive.length / 2));
  }
  alive.sort((a, b) => {
    const ma = samples[a]! > 0 ? successes[a]! / samples[a]! : 0;
    const mb = samples[b]! > 0 ? successes[b]! / samples[b]! : 0;
    return mb - ma || a - b;
  });
  const empiricalMeans = samples.map((s, i) => (s > 0 ? successes[i]! / s : 0));
  return { best: alive[0] ?? 0, samplesPerArm: samples, empiricalMeans, rounds: executedRounds };
}

/**
 * 均匀分配对照（每臂 ⌊budget/K⌋——把预算均摊给注定出局的臂；
 * 与 SH 同输入同形输出，识别率对照的公平基线）。
 */
export function uniformBudgetAllocation(
  mus: ReadonlyArray<number>,
  budget: number,
  seed = 20261002,
): BenchmarkAllocationPlan {
  validateAllocationInputs(mus, budget);
  const rng = benchRng(seed);
  const K = mus.length;
  const samples = new Array<number>(K).fill(0);
  const successes = new Array<number>(K).fill(0);
  const perArm = Math.floor(budget / K);
  for (let i = 0; i < K; i += 1) {
    for (let s = 0; s < perArm; s += 1) {
      samples[i]! += 1;
      successes[i]! += rng() < mus[i]! ? 1 : 0;
    }
  }
  const empiricalMeans = samples.map((s, i) => (s > 0 ? successes[i]! / s : 0));
  let best = 0;
  for (let i = 1; i < K; i += 1) {
    if (empiricalMeans[i]! > empiricalMeans[best]!) best = i; // 平手小下标优先
  }
  return { best, samplesPerArm: samples, empiricalMeans, rounds: 0 };
}

function validateAllocationInputs(mus: ReadonlyArray<number>, budget: number): void {
  if (!Array.isArray(mus) || mus.length === 0) {
    throw new AppError('预算分配: mus 须为非空数组', 'BENCHMARK_ERROR');
  }
  if (mus.some((m) => !(m >= 0 && m <= 1))) {
    throw new AppError('预算分配: 臂均值 μ 须 ∈ [0,1]（质量分归一口径）', 'BENCHMARK_ERROR');
  }
  if (!(budget >= 1)) {
    throw new AppError('预算分配: budget 须 ≥ 1', 'BENCHMARK_ERROR');
  }
}

/** 下一轮跑分预算计划（runAll 附加 / planBenchmarkBudget 产出） */
export interface BenchmarkBudgetPlan {
  /** bai-focus（SH 锦标赛聚焦）| uniform（均摊基线） */
  strategy: 'bai-focus' | 'uniform';
  totalBudget: number;
  allocation: Array<{ name: string; count: number }>;
  recommended: string | undefined;
  rationale: string;
}

// ─────────────────── 结构化报告导出（JSON 就绪） ───────────────────

/** 结构化导出的场景摘要（分数 + 关键延迟 + 违反项） */
export interface StructuredScenarioSummary {
  name: string;
  target: string;
  passed: boolean;
  /** 质量分 = 成功率（0-1） */
  score: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number;
  thresholdViolations: string[];
}

/** 结构化基准报告（机器可读的结论面：分数 + CI + 检验结论 + 建议） */
export interface StructuredBenchmarkReport {
  reportId: string;
  timestamp: number;
  overallPassed: boolean;
  scenarios: StructuredScenarioSummary[];
  /** 成对检验结论（extras.pairwise 提供；空数组 = 未提供成对流） */
  pairwise: PairedComparisonVerdict[];
  regression: RegressionAlarmView | undefined;
  budgetPlan: BenchmarkBudgetPlan | undefined;
  baiFocus: BenchmarkReport['baiFocus'];
  bottleneckFocus: BenchmarkReport['bottleneckFocus'];
  /** 第四轮 R4-A15：长期追踪快照回显（未挂载 undefined） */
  trendTracking: BenchmarkReport['trendTracking'];
  /** 可执行建议（按优先级排序的中文行动项） */
  suggestions: string[];
}

// ═══════════════════════════════════════════════════════════════════
// 第四轮 R4-A15：长期基准追踪 / 模型推荐引擎 / 基准对比矩阵
// （纯函数与独立类——趋势漂移、特征泛化、跨场景横向对比三个全新维度；
//   全部自实现：正态尾概率 A&S 26.2.17 / Theil–Sen / Mann–Kendall /
//   Mann–Whitney 均为文件内非参统计，确定性无 wall-clock 依赖）
// ═══════════════════════════════════════════════════════════════════

/** 标准正态上尾概率 1−Φ(z)（Abramowitz–Stegun 26.2.17，|误差| < 7.5e-8） */
function normalUpperTail(z: number): number {
  if (z < 0) return 1 - normalUpperTail(-z);
  if (z === 0) return 0.5;
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return (Math.exp(-(z * z) / 2) * poly) / Math.sqrt(2 * Math.PI);
}

/** 双侧正态 p-值（|Z| 检验口径） */
function twoSidedNormalP(z: number): number {
  return Math.min(1, 2 * normalUpperTail(Math.abs(z)));
}

/** 均值（空数组按 0——调用方保证非空或显式分支） */
function meanOf(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/**
 * Mann–Kendall 趋势检验（非参单调趋势）：S = Σ_{i<j} sign(x_j − x_i)，
 * 平手修正方差，连续性修正 Z。零假设 H0: 无单调趋势；双侧 p。
 * 与 Theil–Sen 斜率天然配套（同为逐对口径）。
 */
function mannKendallTrend(values: ReadonlyArray<number>): { s: number; z: number; pValue: number } {
  const n = values.length;
  if (n < 2) return { s: 0, z: 0, pValue: 1 };
  let s = 0;
  for (let j = 1; j < n; j += 1) {
    for (let i = 0; i < j; i += 1) s += Math.sign(values[j]! - values[i]!);
  }
  const tieCounts = new Map<number, number>();
  for (const v of values) tieCounts.set(v, (tieCounts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const c of tieCounts.values()) tieTerm += c * (c - 1) * (2 * c + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  let z = 0;
  if (varS > 0) z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0;
  return { s, z, pValue: twoSidedNormalP(z) };
}

/**
 * Theil–Sen 稳健斜率：全部 C(n,2) 逐对斜率 (x_j − x_i)/(j − i) 的中位数。
 * 对单点离群稳健（一个毛刺只污染 n−1 条斜率，中位数不动）——比 OLS 最小
 * 二乘斜率抗噪一个量级，适合「分数历史里混进一次抖动」的真实基准流。
 */
function theilSenSlope(values: ReadonlyArray<number>): number {
  const n = values.length;
  if (n < 2) return 0;
  const slopes: number[] = [];
  for (let j = 1; j < n; j += 1) {
    for (let i = 0; i < j; i += 1) slopes.push((values[j]! - values[i]!) / (j - i));
  }
  slopes.sort((a, b) => a - b);
  const mid = slopes.length >> 1;
  return slopes.length % 2 === 1 ? slopes[mid]! : (slopes[mid - 1]! + slopes[mid]!) / 2;
}

/**
 * Mann–Whitney U 检验（非参两样本对照，平分中位秩 + 平手修正方差 +
 * 连续性修正）：「最近 N 次均值」vs「历史基线均值」是否显著不同。
 */
function mannWhitneyTest(a: ReadonlyArray<number>, b: ReadonlyArray<number>): { u: number; z: number; pValue: number } {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0 || m + n < 2) return { u: 0, z: 0, pValue: 1 };
  const pooled = [
    ...a.map((v) => ({ v, g: 0 })),
    ...b.map((v) => ({ v, g: 1 })),
  ].sort((x, y) => x.v - y.v);
  const rankSum = [0, 0];
  let tieTerm = 0;
  let i = 0;
  while (i < pooled.length) {
    let j = i;
    while (j + 1 < pooled.length && pooled[j + 1]!.v === pooled[i]!.v) j += 1;
    const t = j - i + 1;
    const midRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) rankSum[pooled[k]!.g]! += midRank;
    if (t > 1) tieTerm += t ** 3 - t;
    i = j + 1;
  }
  const u = rankSum[0]! - (m * (m + 1)) / 2;
  const bigN = m + n;
  const sigma2 = (m * n * (bigN + 1 - tieTerm / (bigN * (bigN - 1)))) / 12;
  let z = 0;
  if (sigma2 > 0) {
    const continuity = Math.sign(u - (m * n) / 2) * 0.5;
    z = (u - (m * n) / 2 - continuity) / Math.sqrt(sigma2);
  }
  return { u, z, pValue: twoSidedNormalP(z) };
}

// ─────────────────── 长期基准追踪（趋势 + 漂移检出） ───────────────────

/** 单条分数存档点 */
export interface TrendPoint {
  timestamp: number;
  score: number;
}

/** 趋势序列读数（纯读取口径——斜率 + 显著性 + 近窗 vs 基线） */
export interface TrendSeriesView {
  /** 序列名（模型 id / 场景名） */
  name: string;
  /** 已存档点数（≤ maxHistory——滚动窗口） */
  n: number;
  firstTimestamp: number;
  lastTimestamp: number;
  /** Theil–Sen 稳健斜率（每步分数变化量；单点毛刺不动摇） */
  slope: number;
  /** 相对斜率 = slope / 序列均值（每步相对漂移，跨序列可比） */
  relativeSlope: number;
  /** Mann–Kendall 非参趋势显著性 */
  trend: {
    s: number;
    z: number;
    pValue: number;
    significant: boolean;
    direction: 'up' | 'down' | 'flat';
  };
  /** 最近窗口大小（实际生效值 ≤ 配置值） */
  recentWindow: number;
  /** 最近 N 次均值 */
  recentMean: number;
  /** 历史基线（除最近窗口外的历史）点数（0 = 历史不足） */
  baselineN: number;
  /** 历史基线均值（历史不足时 = recentMean——诚实降级为无对照） */
  baselineMean: number;
  /** 最近窗口 vs 历史基线 Mann–Whitney 对照（历史不足 → 'insufficient'） */
  recentVsBaseline: {
    delta: number;
    pValue: number;
    significant: boolean;
    verdict: 'below' | 'above' | 'stable' | 'insufficient';
  };
  /** 分数漂移检出 = 趋势显著下降 或 近窗显著低于基线（任一口径确证） */
  driftDetected: boolean;
  /** 中文读数（检出 / 平稳） */
  insight: string;
}

/** runAll 附加的趋势快照（timestamp + 全部序列视图） */
export interface BenchmarkTrendSnapshot {
  timestamp: number;
  series: TrendSeriesView[];
}

/**
 * 长期基准追踪器（第四轮 R4-A15）——模型/场景分数的滚动历史存档 +
 * 趋势显著性 + 「最近 N 次 vs 历史基线」对照。
 *
 * 检出口径两条独立证据链（任一确证即 driftDetected）：
 * 1. Mann–Kendall 单调趋势显著下降（整个滚动历史的方向证据）；
 * 2. 最近 windowSize 次均值显著低于此前历史基线（Mann–Whitney——
 *    对「先稳后降」的变点结构敏感，比全历史趋势检验更快）。
 * 平稳流在 H0 下两条链误报均 ≤ α（名义口径），确定性可复现（注入时钟）。
 */
export class BenchmarkTrendTracker {
  private readonly windowSizeValue: number;
  private readonly maxHistoryValue: number;
  private readonly alphaValue: number;
  private readonly nowFn: () => number;
  private readonly seriesMap = new Map<string, TrendPoint[]>();

  constructor(options?: { windowSize?: number; maxHistory?: number; alpha?: number; now?: () => number }) {
    this.windowSizeValue = Math.max(2, Math.floor(options?.windowSize ?? 5));
    this.maxHistoryValue = Math.max(4, Math.floor(options?.maxHistory ?? 40));
    this.alphaValue = options?.alpha ?? 0.05;
    this.nowFn = options?.now ?? (() => Date.now());
    if (!(this.alphaValue > 0 && this.alphaValue < 1)) {
      throw new AppError('BenchmarkTrendTracker: alpha 须 ∈ (0,1)', 'BENCHMARK_ERROR');
    }
  }

  /**
   * 记录一条分数（滚动存档：超出 maxHistory 截断最旧）。返回该序列趋势视图。
   * @param timestamp 缺省用注入时钟（确定性口径——验证脚本可注入固定时钟）
   */
  record(name: string, score: number, timestamp?: number): TrendSeriesView {
    const pts = this.seriesMap.get(name) ?? [];
    pts.push({ timestamp: timestamp ?? this.nowFn(), score });
    if (pts.length > this.maxHistoryValue) pts.splice(0, pts.length - this.maxHistoryValue);
    this.seriesMap.set(name, pts);
    return this.buildView(name, pts);
  }

  /** 某序列趋势视图（无记录 undefined；纯读取） */
  view(name: string): TrendSeriesView | undefined {
    const pts = this.seriesMap.get(name);
    return pts && pts.length > 0 ? this.buildView(name, pts) : undefined;
  }

  /** 全部序列视图（按序列名升序——确定性） */
  views(): TrendSeriesView[] {
    return [...this.seriesMap.keys()].sort((a, b) => a.localeCompare(b)).map((name) => this.view(name)!);
  }

  /** 某序列存档副本（审计口径——外部只读） */
  points(name: string): TrendPoint[] {
    return [...(this.seriesMap.get(name) ?? [])];
  }

  private buildView(name: string, pts: TrendPoint[]): TrendSeriesView {
    const scores = pts.map((p) => p.score);
    const n = scores.length;
    const mean = meanOf(scores);
    const slope = theilSenSlope(scores);
    const mk = mannKendallTrend(scores);
    const trendSignificant = mk.pValue < this.alphaValue;
    const direction: 'up' | 'down' | 'flat' = !trendSignificant ? 'flat' : mk.s > 0 ? 'up' : 'down';
    const recentCount = Math.min(this.windowSizeValue, n);
    const baselineCount = n - recentCount;
    const recent = scores.slice(n - recentCount);
    const recentMean = meanOf(recent);
    const baselineMean = baselineCount > 0 ? meanOf(scores.slice(0, baselineCount)) : recentMean;
    let rnb: TrendSeriesView['recentVsBaseline'];
    if (baselineCount >= 3 && recentCount >= 3) {
      const mw = mannWhitneyTest(recent, scores.slice(0, baselineCount));
      const significant = mw.pValue < this.alphaValue;
      const delta = recentMean - baselineMean;
      rnb = {
        delta,
        pValue: mw.pValue,
        significant,
        verdict: !significant ? 'stable' : delta < 0 ? 'below' : 'above',
      };
    } else {
      rnb = { delta: recentMean - baselineMean, pValue: 1, significant: false, verdict: 'insufficient' };
    }
    const driftDetected = (trendSignificant && direction === 'down') || rnb.verdict === 'below';
    return {
      name,
      n,
      firstTimestamp: pts[0]!.timestamp,
      lastTimestamp: pts[n - 1]!.timestamp,
      slope,
      relativeSlope: mean !== 0 ? slope / mean : 0,
      trend: { s: mk.s, z: mk.z, pValue: mk.pValue, significant: trendSignificant, direction },
      recentWindow: recentCount,
      recentMean,
      baselineN: baselineCount,
      baselineMean,
      recentVsBaseline: rnb,
      driftDetected,
      insight: driftDetected
        ? `分数漂移检出：${name} Theil–Sen 斜率 ${slope.toFixed(4)}/步（Mann–Kendall p = ${mk.pValue.toFixed(4)}${trendSignificant ? ' 显著下降' : ''}），最近 ${recentCount} 次均值 ${recentMean.toFixed(3)} vs 历史基线 ${baselineMean.toFixed(3)}（${rnb.verdict === 'below' ? `Mann–Whitney p = ${rnb.pValue.toFixed(4)} 显著低于` : '趋势口径确证'}）——查变更窗口`
        : `平稳：${name} 斜率 ${slope.toFixed(4)}/步（Mann–Kendall p = ${mk.pValue.toFixed(3)} 不显著），最近 ${recentCount} 次均值 ${recentMean.toFixed(3)} vs 基线 ${baselineMean.toFixed(3)}（${rnb.verdict === 'stable' ? '无显著差异' : rnb.verdict === 'insufficient' ? '历史不足，暂无对照' : '显著升高'}）`,
    };
  }
}

// ─────────────────── 模型推荐引擎（任务特征 → 最优模型） ───────────────────

/** 任务特征画像（推荐输入——类型为分类门，复杂度/预算为连续插值维） */
export interface TaskFeatureProfile {
  /** 任务类型标签（如 'code' / 'doc' / 'math'——不同类型互不插值） */
  type: string;
  /** 复杂度 ∈ [0,1]（越界截断） */
  complexity: number;
  /** 预算（任意正数；对数尺度度量距离，比值 100 倍记距离 1） */
  budget: number;
}

/** 一条「任务特征 × 模型 → 分数」历史记录 */
export interface ModelOutcomeRecord {
  features: TaskFeatureProfile;
  modelId: string;
  /** 该任务上该模型的分数（越高越好） */
  score: number;
}

/** 推荐读数（查表 + 插值 / 诚实回退） */
export interface RecommendationView {
  /** 推荐模型 id */
  modelId: string;
  /**
   * specialized：同型近邻存在且距离 ≈ 0（有该特征档位的直接历史）；
   * interpolated：同型半径内有近邻但无零距离档位（泛化插值）；
   * global-fallback：无同型历史——诚实回退全历史全局最优（不装懂）。
   */
  mode: 'specialized' | 'interpolated' | 'global-fallback';
  /** 邻域支撑度 [0,1]（近邻越密越近越高；fallback 恒 ≤ 0.5 低置信） */
  confidence: number;
  /** 推荐模型在邻域加权口径下的期望分 */
  expectedScore: number;
  /** 参与插值的近邻记录数（fallback = 0） */
  neighborCount: number;
  /** 最近邻（距离升序 / 同距按 modelId 升序，前 5 条） */
  nearest: ReadonlyArray<{ modelId: string; score: number; distance: number; weight: number }>;
  /** 全量候选排名（期望分降序 / 同分按 modelId 升序——确定性） */
  ranking: ReadonlyArray<{ modelId: string; expectedScore: number }>;
  /** 中文读数 */
  insight: string;
}

/** 推荐命中率滚动统计 */
export interface RecommendationHitStats {
  total: number;
  hits: number;
  hitRate: number;
  /** 滚动窗口大小 */
  rollingWindow: number;
  /** 最近 rollingWindow 条中的命中数 */
  rollingHits: number;
  rollingHitRate: number;
}

/** 任务特征距离：类型不同 → ∞（不插值）；同型 → 复杂度与预算对数距离均值 */
function taskFeatureDistance(a: TaskFeatureProfile, b: TaskFeatureProfile): number {
  if (a.type !== b.type) return Number.POSITIVE_INFINITY;
  const ca = clampUnit(a.complexity);
  const cb = clampUnit(b.complexity);
  const dComplexity = Math.abs(ca - cb);
  const dBudget =
    a.budget > 0 && b.budget > 0 ? Math.min(1, Math.abs(Math.log(a.budget / b.budget)) / Math.log(100)) : 1;
  return (dComplexity + dBudget) / 2;
}

/**
 * 模型推荐引擎（第四轮 R4-A15）——「任务特征 → 最优模型」历史表 + 泛化插值。
 *
 * recommend 口径：同型（type 相同）且特征距离 ≤ radius 的历史记录构成
 * 邻域，按反距离权重 w = 1/(d + 0.05) 聚合各模型分数（IDW——近的档位
 * 权重大），argmax 即推荐；零距离档位存在 → specialized，否则
 * interpolated；无任何同型近邻 → 全历史等权聚合的全局最优（诚实回退，
 * mode='global-fallback'、置信度封顶 0.5——明确告诉调用方「这是猜的」）。
 * 全程确定性（无 RNG；同分按 modelId 升序打破并列）。
 */
export class BenchmarkRecommender {
  private readonly radiusValue: number;
  private readonly rollingWindowValue: number;
  private readonly history: ModelOutcomeRecord[] = [];
  private readonly outcomes: boolean[] = [];

  constructor(options?: { radius?: number; rollingWindow?: number }) {
    this.radiusValue = options?.radius ?? 0.25;
    this.rollingWindowValue = Math.max(1, Math.floor(options?.rollingWindow ?? 20));
    if (!(this.radiusValue > 0)) {
      throw new AppError('BenchmarkRecommender: radius 须 > 0', 'BENCHMARK_ERROR');
    }
  }

  /** 登记一条历史（「任务特征 × 模型 → 分子」——推荐表的喂入口） */
  record(outcome: ModelOutcomeRecord): void {
    this.history.push({
      features: {
        type: String(outcome.features?.type ?? ''),
        complexity: clampUnit(outcome.features?.complexity ?? 0),
        budget: Number.isFinite(outcome.features?.budget) && outcome.features!.budget > 0 ? outcome.features!.budget : 1,
      },
      modelId: String(outcome.modelId),
      score: Number.isFinite(outcome.score) ? outcome.score : 0,
    });
  }

  /** 批量登记 */
  ingest(records: ReadonlyArray<ModelOutcomeRecord>): void {
    for (const r of records) this.record(r);
  }

  /** 历史记录数（空表推荐 → global-fallback 且 ranking 空 → modelId ''） */
  get size(): number {
    return this.history.length;
  }

  /** 按任务特征推荐（确定性） */
  recommend(features: TaskFeatureProfile): RecommendationView {
    const neighbors = this.history
      .map((r) => ({ r, d: taskFeatureDistance(r.features, features) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= this.radiusValue);
    let mode: RecommendationView['mode'];
    let ranking: Array<{ modelId: string; expectedScore: number }>;
    let confidence: number;
    let nearestList: Array<{ modelId: string; score: number; distance: number; weight: number }> = [];
    if (neighbors.length === 0) {
      // 诚实回退：无同型历史——全历史等权聚合的全局最优（置信封顶 0.5）
      mode = 'global-fallback';
      const agg = new Map<string, { sum: number; count: number }>();
      for (const r of this.history) {
        const cell = agg.get(r.modelId) ?? { sum: 0, count: 0 };
        cell.sum += r.score;
        cell.count += 1;
        agg.set(r.modelId, cell);
      }
      ranking = [...agg.entries()]
        .map(([modelId, v]) => ({ modelId, expectedScore: v.sum / v.count }))
        .sort((a, b) => b.expectedScore - a.expectedScore || a.modelId.localeCompare(b.modelId));
      confidence = Math.min(0.5, this.history.length / Math.max(1, this.history.length + 8));
    } else {
      const weighted = new Map<string, { sum: number; weight: number }>();
      let totalWeight = 0;
      const nearestDetail: Array<{ modelId: string; score: number; distance: number; weight: number }> = [];
      for (const { r, d } of neighbors) {
        const w = 1 / (d + 0.05);
        totalWeight += w;
        const cell = weighted.get(r.modelId) ?? { sum: 0, weight: 0 };
        cell.sum += w * r.score;
        cell.weight += w;
        weighted.set(r.modelId, cell);
        nearestDetail.push({ modelId: r.modelId, score: r.score, distance: d, weight: w });
      }
      ranking = [...weighted.entries()]
        .map(([modelId, v]) => ({ modelId, expectedScore: v.sum / v.weight }))
        .sort((a, b) => b.expectedScore - a.expectedScore || a.modelId.localeCompare(b.modelId));
      const minDistance = Math.min(...neighbors.map((x) => x.d));
      mode = minDistance <= 1e-9 ? 'specialized' : 'interpolated';
      confidence = totalWeight / (totalWeight + 3);
      nearestDetail.sort((a, b) => a.distance - b.distance || a.modelId.localeCompare(b.modelId));
      nearestList = nearestDetail.slice(0, 5);
    }
    const modelId = ranking[0]?.modelId ?? '';
    const expectedScore = ranking[0]?.expectedScore ?? 0;
    const modeText =
      mode === 'global-fallback'
        ? `无同型历史——诚实回退全局最优（${this.history.length} 条全历史聚合，置信封顶 0.5）`
        : mode === 'specialized'
          ? `同型零距离档位在案（specialized）`
          : `同型半径内泛化插值（interpolated，${neighbors.length} 条近邻 IDW）`;
    return {
      modelId,
      mode,
      confidence,
      expectedScore,
      neighborCount: neighbors.length,
      nearest: nearestList,
      ranking,
      insight: `推荐 ${modelId || '（无历史）'}：${modeText}，邻域期望分 ${expectedScore.toFixed(3)}，置信 ${confidence.toFixed(3)}${
        ranking.length > 1 ? `；次选 ${ranking[1]!.modelId}（${ranking[1]!.expectedScore.toFixed(3)}）` : ''
      }`,
    };
  }

  /**
   * 登记一条推荐结果对照（命中率统计喂入口）。
   * @param actualBest 该任务事后实测最优模型（held-out 真值——命中口径）
   */
  recordOutcome(features: TaskFeatureProfile, recommendedModelId: string, actualBestModelId: string): { hit: boolean } & RecommendationHitStats {
    void features;
    const hit = recommendedModelId === actualBestModelId;
    this.outcomes.push(hit);
    return { hit, ...this.hitStats() };
  }

  /** 命中率读数（总口径 + 滚动口径；纯读取） */
  hitStats(): RecommendationHitStats {
    const total = this.outcomes.length;
    const hits = this.outcomes.filter(Boolean).length;
    const rolling = this.outcomes.slice(-this.rollingWindowValue);
    const rollingHits = rolling.filter(Boolean).length;
    return {
      total,
      hits,
      hitRate: total > 0 ? hits / total : 0,
      rollingWindow: this.rollingWindowValue,
      rollingHits,
      rollingHitRate: rolling.length > 0 ? rollingHits / rolling.length : 0,
    };
  }
}

// ─────────────────── 基准对比矩阵（多模型 × 多场景） ───────────────────

/** 矩阵单格：相对场景最优的百分比 + 显著性标记（与逐对检验一致） */
export interface BenchmarkMatrixCell {
  model: string;
  scenario: string;
  /** 该格是否有观测（无数据格诚实标注，不参与场景最优判定） */
  hasData: boolean;
  /** 分数流均值（无数据 undefined） */
  mean?: number;
  /** 相对本场景最优的百分比（最优 = 100；无数据 undefined） */
  relativePercent?: number;
  /** 热力值 [0,1] = mean / 场景最优（热力图数据结构——直接映射色阶） */
  heat?: number;
  /** 本场景均值最优（并列取 models 序首个） */
  isBest: boolean;
  /**
   * 与本场景最优流的成对符号检验（pairedSignTest 同函数裁决）：
   * best（该格即最优）/ sig-worse（显著劣于最优）/ ns（统计上分不出）/
   * sig-better（显著优于名义最优——均值并列时的兜底口径）
   */
  significance: 'best' | 'sig-worse' | 'ns' | 'sig-better';
  /** 与最优流符号检验 p 值（最优格 / 无数据格 → 1） */
  pValue: number;
  /** 有效配对数 */
  n: number;
  /** 显示标记：★ 最优 / ** 显著劣于最优 / ns 不显著 / † 显著优于名义最优 / — 无数据 */
  marker: string;
}

/** 对比矩阵（grid[模型序][场景序] + 平铺 cells + 汇总口径） */
export interface BenchmarkComparisonMatrix {
  models: string[];
  scenarios: string[];
  /** 行 = 模型 × 列 = 场景（与 models/scenarios 序一致） */
  grid: BenchmarkMatrixCell[][];
  /** 全部格子平铺（JSON 导出面） */
  cells: BenchmarkMatrixCell[];
  alpha: number;
  /** 每模型「场景最优」次数（全模型在案，0 次保留） */
  winsByModel: ReadonlyArray<{ modelId: string; wins: number }>;
  /** 综合冠军（win 最多；并列取 models 序首个；全空 undefined） */
  overallBest: string | undefined;
  insight: string;
}

/**
 * 构建多模型 × 多场景对比矩阵（第四轮 R4-A15）。
 *
 * 每格三层口径：均值（点分）、相对本场景最优的百分比 + heat（热力图
 * 数据）、与最优流的成对符号检验显著性标记——**显著性标记与第三轮
 * pairedSignTest 逐对检验完全一致**（同一函数裁决：矩阵格标记 '**'
 * ⟺ pairedSignTest(best流, 该格流).significant 且方向 A-better）。
 * 这堵住「均值高 0.3% 就宣布赢家」的口径漏洞：均值并列但逐对分不出 → ns。
 *
 * 契约：同场景下各模型的 scores 须等长（按任务配对——与成对检验同前提），
 * 长度不一致 / 重复 (model, scenario) / 观测含未知模型或场景 → 抛
 * AppError（诚实拒绝，不出半张矩阵）。
 */
export function buildBenchmarkMatrix(input: {
  models: ReadonlyArray<string>;
  scenarios: ReadonlyArray<string>;
  observations: ReadonlyArray<{ model: string; scenario: string; scores: ReadonlyArray<number> }>;
  alpha?: number;
}): BenchmarkComparisonMatrix {
  const { models, scenarios, observations } = input;
  const alpha = input.alpha ?? 0.05;
  if (models.length === 0 || scenarios.length === 0) {
    throw new AppError('buildBenchmarkMatrix: models / scenarios 须非空', 'BENCHMARK_ERROR');
  }
  const modelSet = new Set(models);
  const scenarioSet = new Set(scenarios);
  const matrixKey = (model: string, scenario: string): string => `${model}\u0000${scenario}`;
  const obsMap = new Map<string, ReadonlyArray<number>>();
  for (const o of observations) {
    if (!modelSet.has(o.model) || !scenarioSet.has(o.scenario)) {
      throw new AppError(`buildBenchmarkMatrix: 观测含未知模型或场景（${o.model}×${o.scenario}）`, 'BENCHMARK_ERROR');
    }
    if (obsMap.has(matrixKey(o.model, o.scenario))) {
      throw new AppError(`buildBenchmarkMatrix: 重复观测（${o.model}×${o.scenario}）`, 'BENCHMARK_ERROR');
    }
    if (!Array.isArray(o.scores) || o.scores.length === 0) {
      throw new AppError(`buildBenchmarkMatrix: ${o.model}×${o.scenario} 分数流须非空`, 'BENCHMARK_ERROR');
    }
    obsMap.set(matrixKey(o.model, o.scenario), o.scores);
  }
  // 同场景等长校验（配对前提）
  for (const scenario of scenarios) {
    const lengths = new Set(models.map((m) => obsMap.get(matrixKey(m, scenario))?.length ?? 0));
    const present = models.map((m) => obsMap.get(matrixKey(m, scenario))).filter((s) => s !== undefined);
    if (present.length > 1 && lengths.size > 1) {
      throw new AppError(`buildBenchmarkMatrix: 场景 ${scenario} 下各模型分数流须等长（按任务配对）`, 'BENCHMARK_ERROR');
    }
  }
  const grid: BenchmarkMatrixCell[][] = models.map((model) =>
    scenarios.map((scenario) => {
      const scores = obsMap.get(matrixKey(model, scenario));
      return {
        model,
        scenario,
        hasData: scores !== undefined,
        isBest: false,
        significance: 'ns' as BenchmarkMatrixCell['significance'],
        pValue: 1,
        n: 0,
        marker: '—',
      };
    }),
  );
  for (let j = 0; j < scenarios.length; j += 1) {
    const scenario = scenarios[j]!;
    const present = models
      .map((m, i) => ({ i, m, scores: obsMap.get(matrixKey(m, scenario)) }))
      .filter((x) => x.scores !== undefined);
    if (present.length === 0) continue;
    let bestIdx = present[0]!.i;
    let bestMean = -Infinity;
    for (const p of present) {
      const mu = meanOf(p.scores!);
      if (mu > bestMean) {
        bestMean = mu;
        bestIdx = p.i;
      }
    }
    const bestScores = obsMap.get(matrixKey(models[bestIdx]!, scenario))!;
    for (const p of present) {
      const cell = grid[p.i]![j]!;
      const mu = meanOf(p.scores!);
      cell.mean = Math.round(mu * 10000) / 10000;
      cell.n = p.scores!.length;
      const ratio = bestMean !== 0 ? mu / bestMean : mu === bestMean ? 1 : 0;
      cell.relativePercent = Math.round(ratio * 1000) / 10;
      cell.heat = Math.max(0, Math.min(1, ratio));
      if (p.i === bestIdx) {
        cell.isBest = true;
        cell.significance = 'best';
        cell.pValue = 1;
        cell.marker = '★';
        continue;
      }
      const verdict = pairedSignTest(bestScores, p.scores!, { alpha });
      cell.pValue = Math.round(verdict.pValue * 10000) / 10000;
      if (verdict.significant && verdict.direction === 'A-better') {
        cell.significance = 'sig-worse';
        cell.marker = '**';
      } else if (verdict.significant && verdict.direction === 'B-better') {
        cell.significance = 'sig-better';
        cell.marker = '†';
      } else {
        cell.significance = 'ns';
        cell.marker = 'ns';
      }
    }
  }
  const cells = grid.flat();
  const winsByModel = models.map((modelId) => ({
    modelId,
    wins: cells.filter((c) => c.isBest && c.model === modelId).length,
  }));
  const maxWins = Math.max(0, ...winsByModel.map((w) => w.wins));
  const overallBest = maxWins > 0 ? winsByModel.find((w) => w.wins === maxWins)?.modelId : undefined;
  const sigCells = cells.filter((c) => c.significance === 'sig-worse').length;
  const nsCells = cells.filter((c) => c.significance === 'ns').length;
  const bestCells = cells.filter((c) => c.significance === 'best').length;
  return {
    models: [...models],
    scenarios: [...scenarios],
    grid,
    cells,
    alpha,
    winsByModel,
    overallBest,
    insight: `${models.length} 模型 × ${scenarios.length} 场景：${bestCells} 格场景最优、${sigCells} 格显著劣于最优（**）、${nsCells} 格统计上分不出（ns）——综合冠军 ${overallBest ?? '（无数据）'}（win ${maxWins}/${scenarios.length}）`,
  };
}

/**
 * 对比矩阵 → Markdown 表（行 = 模型，列 = 场景；格 = 相对百分比 + 标记）。
 */
export function benchmarkMatrixToMarkdown(matrix: BenchmarkComparisonMatrix): string {
  const lines: string[] = [
    `# 基准对比矩阵（${matrix.models.length} 模型 × ${matrix.scenarios.length} 场景，α = ${matrix.alpha}）`,
    '',
    `> 标记：★ 场景最优　** 显著劣于最优（成对符号检验 p < α）　ns 统计上分不出　— 无数据`,
    '',
    `| 模型 | ${matrix.scenarios.join(' | ')} | 场景最优数 |`,
    `|------|${matrix.scenarios.map(() => '------').join('|')}|------|`,
  ];
  for (const modelId of matrix.models) {
    const row = matrix.grid[matrix.models.indexOf(modelId)]!;
    const cells = row.map((c) => (c.hasData ? `${c.relativePercent!.toFixed(1)}% ${c.marker}` : '—'));
    const wins = matrix.winsByModel.find((w) => w.modelId === modelId)?.wins ?? 0;
    lines.push(`| ${modelId}${modelId === matrix.overallBest ? ' 🏆' : ''} | ${cells.join(' | ')} | ${wins} |`);
  }
  lines.push('', `**综合冠军：${matrix.overallBest ?? '无数据'}** —— ${matrix.insight}`);
  return lines.join('\n');
}
