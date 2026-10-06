/**
 * generate-domestic-patches.mjs — 自动生成全部国产模型的 cordis patch YML
 *
 * 用法：node scripts/generate-domestic-patches.mjs
 * 输出：patches/domestic-models/<vendor>.yml（每厂商一个）+ all-domestic.yml（全量合并）
 *
 * 设计原则：patch 中**不含任何 apiKey**。DSH 会根据用户在 Web UI / 环境变量
 * （见各文件头部注释中的变量名）中的配置，自动把 Key 注入请求头。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../patches/domestic-models');

/** 国产模型目录：vendor → 端点 / 环境变量 / 模型清单 */
const VENDORS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    endpoint: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    strategist: 'deepseek-v4-pro',
    models: [
      { id: 'deepseek-v4-pro', timeout: 90000, maxConcurrency: 3, costPerKToken: 0.014, contextWindow: 128000, taskScores: { 'code-generation': 0.9, architecture: 0.85, debugging: 0.85, refactoring: 0.8 } },
      { id: 'deepseek-v4-flash', timeout: 30000, maxConcurrency: 5, costPerKToken: 0.002, contextWindow: 128000, taskScores: { documentation: 0.8, 'test-generation': 0.75, general: 0.7 } },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问 Qwen（阿里云 DashScope）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_API_KEY',
    strategist: 'qwen-max',
    models: [
      { id: 'qwen-max', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.02, contextWindow: 32768, taskScores: { general: 0.85, analysis: 0.85, documentation: 0.8 } },
      { id: 'qwen-plus', timeout: 45000, maxConcurrency: 5, costPerKToken: 0.004, contextWindow: 131072, taskScores: { general: 0.75, documentation: 0.8, 'test-generation': 0.7 } },
      { id: 'qwen-turbo', timeout: 30000, maxConcurrency: 8, costPerKToken: 0.001, contextWindow: 1000000, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZHIPU_API_KEY',
    strategist: 'glm-4.5',
    models: [
      { id: 'glm-4.5', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.004, contextWindow: 128000, taskScores: { 'code-generation': 0.8, general: 0.8, analysis: 0.8 } },
      { id: 'glm-4-flash', timeout: 30000, maxConcurrency: 8, costPerKToken: 0, contextWindow: 128000, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    envVar: 'MOONSHOT_API_KEY',
    strategist: 'moonshot-v1-128k',
    models: [
      { id: 'moonshot-v1-128k', timeout: 90000, maxConcurrency: 3, costPerKToken: 0.008, contextWindow: 131072, taskScores: { analysis: 0.85, documentation: 0.8, general: 0.75 } },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    endpoint: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
    strategist: 'abab6.5s-chat',
    models: [
      { id: 'abab6.5s-chat', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.005, contextWindow: 245760, taskScores: { general: 0.7, documentation: 0.7 } },
    ],
  },
  {
    id: 'spark',
    label: '讯飞星火 Spark',
    endpoint: 'https://spark-api-open.xf-yun.com/v1',
    envVar: 'SPARK_API_KEY',
    strategist: 'generalv4.0',
    models: [
      { id: 'generalv4.0', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.005, contextWindow: 8192, taskScores: { general: 0.75, documentation: 0.7 } },
      { id: 'generalv3.5', timeout: 45000, maxConcurrency: 5, costPerKToken: 0.003, contextWindow: 8192, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'hunyuan',
    label: '腾讯混元 Hunyuan',
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
    envVar: 'HUNYUAN_API_KEY',
    strategist: 'hunyuan-pro',
    models: [
      { id: 'hunyuan-pro', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.01, contextWindow: 65536, taskScores: { general: 0.8, analysis: 0.8 } },
      { id: 'hunyuan-turbo', timeout: 30000, maxConcurrency: 5, costPerKToken: 0.003, contextWindow: 32768, taskScores: { general: 0.7 } },
    ],
  },
  {
    id: 'ernie',
    label: '百度文心 ERNIE（千帆）',
    endpoint: 'https://qianfan.baidubce.com/v2',
    envVar: 'QIANFAN_API_KEY',
    strategist: 'ernie-4.0-8k',
    models: [
      { id: 'ernie-4.0-8k', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.017, contextWindow: 8192, taskScores: { general: 0.8, documentation: 0.75 } },
      { id: 'ernie-speed-128k', timeout: 30000, maxConcurrency: 8, costPerKToken: 0, contextWindow: 131072, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'sensechat',
    label: '商汤日日新 SenseChat',
    endpoint: 'https://api.sensenova.cn/v1',
    envVar: 'SENSENOVA_API_KEY',
    strategist: 'sensechat-5',
    models: [
      { id: 'sensechat-5', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.006, contextWindow: 128000, taskScores: { general: 0.7, analysis: 0.7 } },
    ],
  },
];

/** 渲染单个模型条目（不含 apiKey） */
function renderModel(model, indent) {
  const pad = ' '.repeat(indent);
  const lines = [
    `${pad}- id: ${model.id}`,
    `${pad}  endpoint: ${VENDORS_CURRENT.endpoint}`,
    `${pad}  timeout: ${model.timeout}`,
    `${pad}  maxConcurrency: ${model.maxConcurrency}`,
    `${pad}  costPerKToken: ${model.costPerKToken}`,
    `${pad}  contextWindow: ${model.contextWindow}`,
    `${pad}  initialCapabilities:`,
    `${pad}    taskScores:`,
    ...Object.entries(model.taskScores).map(([task, score]) => `${pad}      ${task}: ${score}`),
  ];
  return lines.join('\n');
}

let VENDORS_CURRENT = null;

/** 渲染一个厂商的 patch 文件内容 */
function renderVendorPatch(vendor) {
  VENDORS_CURRENT = vendor;
  const modelBlocks = vendor.models.map((m) => renderModel(m, 10)).join('\n');
  return `# ${vendor.label} — cordis patch（国产模型）
# Key 由 DSH 自动注入请求头：在 Web UI 或环境变量 ${vendor.envVar} 中配置即可，本文件不含任何密钥。
# 用法：将本文件作为 --patch overlay 加载，或合并进 profile 的 cordis.patch.yml。
- insert:
    - id: dsh-proactive
      name: dsh-proactive
      config:
        strategistModel:
          id: ${vendor.strategist}
          endpoint: ${vendor.endpoint}
        models:
${modelBlocks}
`;
}

/** 渲染全量合并 patch */
function renderAllPatch() {
  const allModels = [];
  for (const vendor of VENDORS) {
    VENDORS_CURRENT = vendor;
    for (const m of vendor.models) allModels.push(renderModel(m, 10));
  }
  return `# 全部国产模型 — cordis patch（合并版）
# 覆盖厂商：${VENDORS.map((v) => v.id).join(' / ')}
# Key 由 DSH 自动注入请求头（各厂商对应环境变量见各单厂商 patch 文件），本文件不含任何密钥。
- insert:
    - id: dsh-proactive
      name: dsh-proactive
      config:
        strategistModel:
          id: deepseek-v4-pro
          endpoint: https://api.deepseek.com
        models:
${allModels.join('\n')}
`;
}

/** 渲染根目录 cordis patch YML（封装全部国产模型 + 运行配置，零密钥） */
// 契约：模板须与已提交的 cordis.patch.yml 逐字节一致（含 autonomy 全部功能键），
// 重跑生成器对仓库应是零 diff；新增功能键时同步维护此处模板与 cordis.patch.yml。
function renderRootPatch() {
  const allModels = [];
  for (const vendor of VENDORS) {
    VENDORS_CURRENT = vendor;
    for (const m of vendor.models) allModels.push(renderModel(m, 10));
  }
  return `# cordis patch — dsh-proactive（开箱即用，零手动配置）
# 已封装全部国产模型：${VENDORS.map((v) => v.id).join(' / ')}
# 无需填写任何 apiKey：插件经 ctx 获取 DSH 已配置的 LLM 客户端，
# DSH 自动把用户配置的 Key（Web UI / 环境变量）注入请求头。
# 本文件即 package.json dsh.bundle.patch 指向的 bundle 配置层。
- insert:
    - id: dsh-proactive
      name: dsh-proactive
      config:
        strategistModel:
          id: deepseek-v4-pro
          endpoint: https://api.deepseek.com
        models:
${allModels.join('\n')}
        sentinel:
          watchCodeChanges: true
          watchErrors: true
          watchPerformance: true
          aggregationWindow: 5
          signalSources: []
        qualityThreshold: 0.7
        maxRetries: 2
        globalTimeout: 300000
        enableProgress: true
        progressPort: 9877
        verbose: true
        experienceStorePath: .scheduler/memory.json
        encryption:
          enabled: false
          algorithm: aes-256-gcm
          fullFileEncryption: true
        sync:
          localNodeId: "node-dev-01"
          peers: []
        consensus:
          enabled: false
          localNodeId: "node-01"
          consensusPort: 9880
          electionTimeoutMin: 1500
          electionTimeoutMax: 3000
          heartbeatInterval: 500
          cluster: []
        hotReload:
          enabled: false
          watchDirs: [src]
          watchExtensions: [.ts, .tsx, .js]
          debounceMs: 1000
          buildCommand: pnpm build
          autoRollback: true
        tenants: []
        # ── 以下键完整列出 schema/运行时默认值：用户层按 id 覆盖是整行替换（非深度合并），
        #    bundle 层全部显式给出，照抄即得完整行，不会漏键回退到隐式默认。
        # 数据目录（心智报告 / 审计日志 / 租户库 / raft 日志落盘处）
        dataDir: '.scheduler'
        # 模式置信度 ≥ 此阈值走记忆快路径（运行时缺省 0.9）
        memoryFastPathThreshold: 0.9
        # 自主心跳外环：设 { enabled: false } 可完全关闭自主循环
        autonomy:
          enabled: true
          heartbeatMs: 30000
          # 12.0 任意时刻证据：进化适应度置信序列下界 + e-BH FDR 淘汰 +
          # 元认知 KPI 保证层（退化判定偷看免疫）。缺省关闭（零漂移）
          anytimeEvidence:
            enabled: false
            alpha: 0.05
            reference: 0.5
          # 13.0 保形校准：预测区间精确覆盖保证 + 反思阈值风险受控选择。
          # 缺省关闭（回退既有泊松近似/步进校准口径）
          conformal:
            enabled: false
            alpha: 0.1
            maxCalibration: 200
            thresholdTargetRisk: 0.1
            thresholdConfidence: 0.95
          # 14.0 质量-多样性进化：MAP-Elites 前沿 niche 均匀采样探索
          # （敢为/节俭/警觉流派等量预算，多样性坍缩被阻断）。缺省关闭
          qualityDiversity:
            enabled: false
            exploreRate: 0.25
          # 15.0 运行时验证：治理迁移事件流喂入 LTLf 规约监视器；
          # critical 违规自动触发 Kill Switch。缺省关闭（不挂载即不监视）
          runtimeVerification:
            enabled: false
            specs: []
          # 17.0 最优传输：元认知挂载 Wasserstein-1 形状漂移监视
          # （均值不变而形状巨变的「换了世界」可见）。缺省关闭
          optimalTransport:
            enabled: false
            kpis: [avgQuality, avgLatency]
            windowSize: 50
            referenceSize: 200
            thresholdQuantile: 0.95
            minSamples: 20
          # 18.0 信息几何：策略变异升级为 Fisher 流形自然变异
          # （协方差主轴联合步 + KL 信任域，步长以 nat 计价）。缺省关闭
          informationGeometry:
            enabled: false
            klBudget: 1.2
            stepScale: 0.5
          # 19.0 最优停止：规则 C 成本闸门从魔数 defer 升级为
          # 继续价值裁决（向后归纳精确阈值 + 先知不等式审计）。缺省关闭
          optimalStopping:
            enabled: false
            horizon: 3
            minSamples: 8
          # 20.0 层论共识：注册 sheaf_consensus Tool（多源信念结构化
          # 融合 + 结构性分歧检测）。缺省关闭（不注册即零漂移）
          sheafConsensus:
            enabled: false
            misfitTolerance: 0.0025
          # 21.0 最优索引调度：候选排序升级为 Gittins 指数口径（可证明
          # 最优；学习溢价随证据积累自动归零）。缺省关闭（零漂移）
          indexScheduling:
            enabled: false
            discount: 0.95
            maxCount: 48
          # 22.0 预算最优路由：Bandits with Knapsacks（影子价格从预算
          # 稀缺性内生涌现；治理器未配置预算时挂载不生效）。缺省关闭
          banditKnapsack:
            enabled: false
            ucbAlpha: 0.05
            feasibilitySlack: 0.25
            horizonDefault: 100
          # 稳健统计（预留配置位：运行时接线随后续版本进入）。缺省关闭
          robustStatistics:
            enabled: false
            alpha: 0.05
          # 差分隐私（预留配置位：运行时接线随后续版本进入）。缺省关闭
          privacy:
            enabled: false
            epsilon: 3.0
            delta: 0.000001
          # 容量规划（预留配置位：运行时接线随后续版本进入）。缺省关闭
          capacityPlanning:
            enabled: false
            targetWaitMs: 5000
            defaultScv: 2.0
          # 26.0 高斯过程：世界模型预测校准升级为 GP 序列修正（带不确定度
          # 的乘性因子；校准史不足时恒 1）。缺省关闭（零漂移）
          gaussianProcess:
            enabled: false
            maxPoints: 48
            minPoints: 6
            sigmaN: 0.15
          # 27.0 卡尔曼滤波：KPI 异常判定升级为 (level, slope) 趋势滤波 +
          # NIS χ² 门控（99.7% 不该发生的才算异常）。缺省关闭
          kalmanFilter:
            enabled: false
            qLevel: 0.0001
            qSlope: 0.000001
            r: 0.0002
            gateP: 0.997
          # 28.0 极值理论：延迟样本 POT/GPD 尾部外推（p99.9 不再是样本
          # 最大值的运气）。缺省关闭
          extremeValue:
            enabled: false
            targetP99Ms: 30000
            minSamples: 60
            thresholdQuantile: 0.9
            bootstrap: 200
          # 29.0 MCTS：深思推荐从 beam search 切换 UCT（序贯预算分配）。
          # 缺省关闭（零漂移——原 beam search）
          mcts:
            enabled: false
            iterations: 600
            explorationC: 1.41421356
            discount: 0.95
          # 30.0 次模优化：好奇心探索预算从新颖度 top-k 升级为加权覆盖
          # 惰性贪心（CELF，≥ (1−1/e)·OPT）。缺省关闭（零漂移）
          submodular:
            enabled: false
            coverageStrength: 0.7
          # 31.0 对抗组合：模型评分叠加 Fixed-Share Hedge 有界乘数——
          # 对手无论怎么出招，对事后最优固定模型的遗憾 ≤ √(2T lnN)。
          # 缺省关闭（零漂移——乘数恒 1）
          hedgePortfolio:
            enabled: false
            eta: 0.3
            alpha: 0.05
          # 32.0 全局指派：同批动态选型节点经匈牙利算法求全局总收益最优
          # 一对一指派（O(n³) 精确解 + 对偶证书；最优模型不被重复超订）。
          # 缺省关闭（零漂移——逐节点贪心）
          optimalAssignment:
            enabled: false
            candidateCap: 8
          # 33.0 随机矩阵：模型失败相关性经 Marchenko–Pastur 噪声带清洗，
          # 头号特征值显著超带 = 共同因子暴露（热备冗余是统计幻觉）。
          # 缺省关闭（零漂移）
          randomMatrix:
            enabled: false
            window: 32
            minModels: 4
            edgeFactor: 1.1
            systemicShare: 0.35
          # 34.0 分布鲁棒：每模型超时 = margin × CVaR_α(延迟史)（α 置信
          # 水平，0.95 即最坏 5% 尾）——按最坏尾部的期望定价，取代固定
          # 魔数。依赖 robustStatistics 启用。缺省关闭
          cvarTimeouts:
            enabled: false
            alpha: 0.95
            margin: 1.5
            minSamples: 30
            floorMs: 5000
            capMs: 300000
          # 35.0 反馈控制：并发上限从静态口径升级为闭环 LQR（DARE 闭式
          # 增益 + Lyapunov 稳定证书 + 死区抗抖振）。缺省关闭（零漂移）
          concurrencyControl:
            enabled: false
            target: 0.75
            plantGain: 0.4
            r: 4.0
            deadband: 0.05
          # 37.0 信息瓶颈：蒸馏门槛从纯水位升维为水位 + 信息量双门
          # （IB 保留率 I(T;Y)/I(X;Y) 低于下限 → 样本同构，诚实跳过）。
          # 缺省关闭（零漂移）
          informationBottleneck:
            enabled: false
            beta: 5.0
            retentionFloor: 0.4
          # 38.0 非线性动力学：KPI 体质分类（混沌/持续/反持续/随机；
          # 混沌 → 预测视野 ~1/λ₁ 步）。缺省关闭（零漂移）
          chaosDiagnostics:
            enabled: false
            minPoints: 96
            lambdaThreshold: 0.05
            hurstDelta: 0.08
          # 39.0 谱排序：知识图 PageRank 骨架（related() 联想序升维为
          # 影响力加权；topInfluential 输出知识骨架）。缺省关闭
          spectralRanking:
            enabled: false
            damping: 0.85
          # 40.0 首达时间：熔断冷却的概率定价（逆高斯首达模型解出
          # 「以 target 概率确信已恢复」的最小冷却建议）。缺省关闭
          firstPassageCooldown:
            enabled: false
            targetProb: 0.9
          # 41.0 排队网络：各模型作为独立 M/M(c) 站（Jackson 乘积形式），
          # 心跳 2.9 段解瓶颈站（ρ 最大）——哪一站钳制整条链路。
          # 缺省关闭（零漂移）
          queueingNetwork:
            enabled: false
            rhoThreshold: 0.85
          # 42.0 谱日历：到达节律从数据里解出（FFT 周期图 + Fisher g
          # 检验；显著时相位感知季节因子取代小时直方图）。缺省关闭
          spectralCalendar:
            enabled: false
            bins: 128
          # 43.0 容量前沿：类型需求 × 模型容量的 max-flow / min-cut 诊断
          # （吞吐上限 + 钳制者归因，纯诊断口径）。缺省关闭
          capacityFrontier:
            enabled: false
          # 44.0 公平预算：探索预算按域加权极大极小注水（任何活跃域的
          # 相对份额不被压扁）。缺省关闭（零漂移——原 top-k / 次模）
          fairBudget:
            enabled: false
          # 45.0 OCBA：基准瓶颈确认的最优预算分配（P(CS) 渐近最优，
          # 报告附加 bottleneckFocus）。缺省关闭（零漂移）
          ocbaAllocator:
            enabled: false
            confirmationBudget: 200
          # 49.0 多尺度：KPI 小波视图（趋势/漂移带/突发分离）。
          # 纯读数口径。缺省关闭（零漂移）
          waveletView:
            enabled: false
            minPoints: 64
          # 50.0 潜因子：能力矩阵 ALS 低秩补全（冷启动外推）。
          # 纯诊断口径。缺省关闭（零漂移）
          latentFactors:
            enabled: false
            rank: 3
        # 宿主融合层：全宿主工具可观测 + 安全治理；关闭后 isActive()=false
        hostFusion:
          enabled: true
          observeToolResults: true
          governToolCalls: true
          failureEscalationThreshold: 3
`;
}

/**
 * 落盘 YML：与仓库既有生成物对齐 CRLF 行尾（模板统一以 \n 书写，
 * 写入时整档转换），保证重新生成后与已提交文件的 diff 只有预期变更。
 */
function writeYml(file, content) {
  fs.writeFileSync(file, content.replace(/\n/g, '\r\n'));
}

fs.mkdirSync(outDir, { recursive: true });
let count = 0;
for (const vendor of VENDORS) {
  writeYml(path.join(outDir, `${vendor.id}.yml`), renderVendorPatch(vendor));
  count += 1;
}
writeYml(path.join(outDir, 'all-domestic.yml'), renderAllPatch());
// 根目录 cordis.patch.yml 同步升级为封装全部国产模型的 patch YML（零密钥、开箱即用）
writeYml(path.resolve(__dirname, '../cordis.patch.yml'), renderRootPatch());
console.log(`已生成 ${count} 个厂商 patch + all-domestic.yml → ${outDir}，并升级根目录 cordis.patch.yml`);
