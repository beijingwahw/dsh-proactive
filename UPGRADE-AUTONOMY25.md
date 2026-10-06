# 第二轮创世纪升级公告（Autonomy25）：73 → 98 内核

**版本 0.7.0**（自 0.6.0 升级）。主题：**「自主识别 · 自主判断 · 自主执行」——自主智能本体的进化**。在既有七十三质变内核（3.0 → 75.0，十五层）之上新增 **五个层、25 个数学内核（76.0 → 100.0，编号封顶百数）**，并完成 14 个引擎的全链路接线。全部新内核**缺省关闭、零漂移**——不打开旗标，系统行为与升级前逐位一致。

## 升级概览

- **内核总数**：73 → **98**（`src/core/` 下 98 个内核文件，编号铺满 3.0 → 100.0，百数封顶）
- **新增五层**：感知层 76–80（自主识别）/ 判断层 81–85（自主判断）/ 执行层 86–90（自主执行）/ 进化层 91–95（自主进化）/ 意识层 96–100
- **接线**：14 个引擎（Sentinel / WorldModel / ReflectionEngine / Reflector / DecisionEngine / TaskExecutor / PolicyEvolver / Sandbox / StrategyEvolutionEngine / CuriosityEngine / LongTermMemory / BenchmarkEngine / AutonomyLoop / SelfModel）各获 `attach*` 挂载方法与只读读数方法；适配层位于 `src/engines-frontier/autonomy25.ts`（28 个适配器 / 翻译函数）
- **旗标**：统一收敛于 `autonomy.kernels.<camelCase>.enabled` 命名空间，缺省全 `false`
- **验证**：18 个新数学验证脚本 + 1 个全链路零漂移接线脚本（合计 81 个离线验证脚本全绿，见下）

## 五大新层与 25 内核一览

### 第十六层「感知层」76–80：自主识别——「没见过的东西」有了可计算的口径

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 76.0 | 新奇检测（[novelty-detection.ts](./src/core/novelty-detection.ts)） | Mahalanobis 深度（Ledoit–Wolf 收缩）+ kNN 密度比双证据 + CUSUM 变点（ARL Brook–Evans Markov 精确校准 + 自适应基准窗自愈） | Sentinel | `kernels.noveltySentinel` |
| 77.0 | 因果发现（[causal-discovery.ts](./src/core/causal-discovery.ts)） | PC-stable 骨架 + v-结构定向 + Meek 规则传播，CPDAG 等价类诚实（链 / 对撞精确恢复，729 图全枚举对照） | WorldModel | `kernels.causalDiscovery` |
| 78.0 | 多源对齐（[canonical-correlation.ts](./src/core/canonical-correlation.ts)） | 白化 + Jacobi 特征求解 CCA（Hotelling 1936）：典型相关谱 = 两源共享信息容量，岭正则高维小样本护栏 | WorldModel | `kernels.ccaAlignment` |
| 79.0 | 流形学习（[diffusion-maps.ts](./src/core/diffusion-maps.ts)） | 扩散映射（Coifman–Lafon 2006）+ Isomap：扩散距离等距嵌入，瑞士卷参数恢复 0.98、谱隙定簇 | WorldModel | `kernels.diffusionManifold` |
| 80.0 | 流式概要（[streaming-sketch.ts](./src/core/streaming-sketch.ts)） | Count-Min（只高不低 + ≤ ε‖a‖₁ 概率保证）+ 蓄水池精确等概率 + 指数直方图 ε + Misra–Gries 重元素 | Sentinel | `kernels.streamingSketch` |

### 第十七层「判断层」81–85：自主判断——「接受一个结论」从投票 / 权威升级为数学语义

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 81.0 | 论证（[argumentation.ts](./src/core/argumentation.ts)） | Dung 抽象论证框架语义阶梯：grounded（多项式、必存在）/ preferred / stable，辩护链裁决 | ReflectionEngine | `kernels.argumentation` |
| 82.0 | 众包聚合（[crowd-aggregation.ts](./src/core/crowd-aggregation.ts)） | Dawid–Skene 混淆矩阵 EM：可靠性即票权，垃圾与对抗评分者自动摘牌 | Reflector | `kernels.crowdAggregation` |
| 83.0 | 世界模型学习（[world-model-learning.ts](./src/core/world-model-learning.ts)） | 计数 MLE + Dirichlet 平滑 + 值迭代 + 后继特征（换目标零重规划）+ Dyna 混合经验 | WorldModel | `kernels.worldModelLearning` |
| 84.0 | POMDP 规划（[pomdp-planning.ts](./src/core/pomdp-planning.ts)） | 精确信念更新 + α-向量值迭代（点基下界）× QMDP 上界：信息价值间隙定价「继续听」 | DecisionEngine | `kernels.pomdpPlanner` |
| 85.0 | 符号求解（[symbolic-solver.ts](./src/core/symbolic-solver.ts)） | DPLL 回跳 + 学子句 + #SAT 组件分解：SAT/UNSAT 完备裁决 + 冲突账单 + 可行解计数（鸽笼 UNSAT） | TaskExecutor | `kernels.symbolicFeasibility` |

### 第十八层「执行层」86–90：自主执行——「落地」本身携带数学

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 86.0 | 分层技能（[options-framework.ts](./src/core/options-framework.ts)） | 选项框架（Sutton–Precup–Singh 1999）+ SMDP Q-learning：宏动作 γ^k 时间信用分配（走廊 179× 加速） | TaskExecutor | `kernels.optionsFramework` |
| 87.0 | 安全屏障（[safety-barrier.ts](./src/core/safety-barrier.ts)） | 离散时间控制屏障函数（CBF）安全滤波：最小安全修改而非静默截断（朴素截断 282 违反 vs 0） | TaskExecutor | `kernels.safetyBarrier` |
| 88.0 | 离线评估（[off-policy-evaluation.ts](./src/core/off-policy-evaluation.ts)） | OIS → WIS → PDIS → DR 四阶梯 + 经验伯恩斯坦 CI：反事实估值「算一遍」而非「跑一遍」（DR 误差=0 解析例） | PolicyEvolver | `kernels.offPolicyEvaluation` |
| 89.0 | 安全策略改进（[safe-policy-improvement.ts](./src/core/safe-policy-improvement.ts)） | HCPI 配对差高置信改进：LCB > 0 证书才上线，违反率 ≤ δ、浓度律 √(log/n) 斜率 −0.4997 | PolicyEvolver | `kernels.safePolicyImprovement` |
| 90.0 | 偏好学习（[preference-learning.ts](./src/core/preference-learning.ts)） | Bradley–Terry 牛顿 MLE + Elo：偏好对学价值序，环路检测 + 拟合优度双前置体检（RPS 失效诚实报告） | Reflector | `kernels.preferenceLearning` |

### 第十九层「进化层」91–95：自主进化——方向盘从「目标」换成「新奇 / 对抗 / 预算 / 保真 / 可中断」

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 91.0 | 新奇搜索（[novelty-search.ts](./src/core/novelty-search.ts)） | 抛弃目标只追新奇（Lehman & Stanley）+ MCNS 可行门槛：欺骗迷宫 99/100 vs 纯适应度 0/100 | CuriosityEngine | `kernels.noveltySearch` |
| 92.0 | 自我对弈（[self-play.ts](./src/core/self-play.ts)） | 虚拟博弈收敛（Brown 1951）+ exploitability 弱点货币 + 联赛 exploiter 档案（Kuhn 扑克 −1/18 精确） | StrategyEvolutionEngine | `kernels.selfPlay` |
| 93.0 | 自动机调优（[automl-hyperband.ts](./src/core/automl-hyperband.ts)） | Hyperband 括号调度（Li et al. 2017）：预算守恒逐 bracket 对账，同预算 40/40 命中 95 分位 | BenchmarkEngine | `kernels.automlHyperband` |
| 94.0 | 仿真校准（[simulation-calibration.ts](./src/core/simulation-calibration.ts)） | MMD² + 能量距离 + 分类器密度比再加权：域差量化与 sim-to-real 换算（域差 99.9% 缩减） | Sandbox | `kernels.simulationCalibration` |
| 95.0 | 中断交接（[interruptible-autonomy.ts](./src/core/interruptible-autonomy.ts)） | 可中断自主性（Orseau–Lattimore 2016）离线修正：对抗中断下 Q* 恢复 1.5e-13；闭式交接阈值 τ* = c_H + c_delay | DecisionEngine | `kernels.interruptibleAutonomy` |

### 第二十层「意识层」96–100：五个心智结构封顶百数编号

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 96.0 | 全局工作空间（[global-workspace.ts](./src/core/global-workspace.ts)） | GWT 投标竞争 + 点火阈值 + 级联广播 + 不应期（Baars 可计算化）：「此刻全员该知道什么」由竞争仲裁 | AutonomyLoop | `kernels.globalWorkspace` |
| 97.0 | 元认知信心（[metacognitive-confidence.ts](./src/core/metacognitive-confidence.ts)） | 二阶信号检测论 meta-d′ / d′（M-ratio）+ 四象限分离 + 闭式求助阈值：知道自己不知道 | DecisionEngine | `kernels.metacognitiveConfidence` |
| 98.0 | 经验重放（[experience-replay.ts](./src/core/experience-replay.ts)） | rank-based PER + IS 权重无偏 + 分层配额 + 睡眠固化：只重放不采新（灾难遗忘 88.9% → 0） | LongTermMemory | `kernels.experienceReplay` |
| 99.0 | 注意力经济（[attention-economy.ts](./src/core/attention-economy.ts)） | 凹边际价值 + matroid 贪心 = 穷举最优 + VCG 二价支付：谎报无益 500 次 0 违例（DSIC） | Sentinel | `kernels.attentionEconomy` |
| 100.0 | 自我边界（[self-boundary.ts](./src/core/self-boundary.ts)） | 延迟偶然性能动性检测（40/40）+ do-口径共因消歧 + 身份断点监控：这是我还是世界干的 | SelfModel | `kernels.selfBoundary` |

## 零漂移承诺

本仓库的宪法：**任何新数学不得改变未启用它的行为**。第二轮创世纪升级的接线满足三层零漂移：

1. **缺省关闭**：`autonomy.kernels.*` 新增 25 个旗标缺省全 `false`，不挂载任何新逻辑；
2. **旗标关 = 现状**：`verify-autonomy25-wiring.mjs` 对 14 个引擎逐一对照——未挂载时新读数全部缺席（`undefined`），信号聚合 / 决策 / 执行 / 进化路径行为不变；
3. **挂载纪律分级**：观测口径（76.0 / 80.0 / 97.0 只读读数不改路径）、旁路咨询（77.0 / 78.0 / 79.0 / 83.0 / 96.0 / 98.0 独立旁路计算）、影子计算（81.0 / 90.0 / 92.0 / 99.0 / 100.0 不改主链路数值）、咨询口径（82.0 / 84.0 / 85.0 / 87.0 / 88.0 / 89.0 / 91.0 / 93.0 / 95.0 读数可选采纳）、只读基准（86.0 / 94.0 例行体检）。适配层的数学不动内核：只做「引擎数据 → 内核输入」的翻译与遥测估计（`src/engines-frontier/autonomy25.ts`，与第一轮 genesis25.ts 同款纪律）。

## 验证汇总（全量 81 脚本，0 FAIL）

`npm run build` 成功；`npx tsc --noEmit` 0 错误；`scripts/` 下全部 `verify-*.mjs` 逐一运行，**81/81 通过（退出码 0，0 FAIL）**。其中 19 个新脚本全部打印显式断言计数、合计 **1,273 项断言**；其余 62 个存量脚本（创世纪 0.6.0 基线）全部复验通过。

### 第二轮创世纪新脚本（18 + 1 接线）

| 脚本 | 覆盖 | 断言数 | 结果 |
|------|------|--------|------|
| verify-novelty-detection | 76.0 | 78 | PASS |
| verify-causal-discovery | 77.0 | 94 | PASS |
| verify-alignment-manifold | 78.0 + 79.0 | 79 | PASS |
| verify-streaming-sketch | 80.0 | 68 | PASS |
| verify-argumentation | 81.0 | 52 | PASS |
| verify-crowd-aggregation | 82.0 | 41 | PASS |
| verify-model-pomdp | 83.0 + 84.0 | 46 | PASS |
| verify-symbolic-solver | 85.0 | 80 | PASS |
| verify-execution-kernels | 86.0 + 87.0 | 50 | PASS |
| verify-ope-spi | 88.0 + 89.0 | 59 | PASS |
| verify-preference-learning | 90.0 | 83 | PASS |
| verify-novelty-search | 91.0 | 36 | PASS |
| verify-self-play | 92.0 | 59 | PASS |
| verify-automl-hyperband | 93.0 | 64 | PASS |
| verify-sim-interrupt | 94.0 + 95.0 | 51 | PASS |
| verify-global-workspace | 96.0 | 84 | PASS |
| verify-metacognition-replay | 97.0 + 98.0 | 94 | PASS |
| verify-attention-self | 99.0 + 100.0 | 53 | PASS |
| verify-autonomy25-wiring | 76.0→100.0 全链路接线零漂移 | 102 | PASS |

### 存量脚本（62，全部复验通过）

| 分组 | 脚本 |
|------|------|
| 双心智 | verify-scientist（54）· verify-theorist（51） |
| 质变内核 | verify-unified-evidence · verify-resilience-governance · verify-causal-kernel（50）· verify-active-inference（49）· verify-deliberation（53）· verify-metareasoning（43）· verify-abstraction（40） |
| 保证层 12.0-16.0 | verify-anytime-evidence（24）· verify-conformal（32）· verify-quality-diversity（28）· verify-runtime-verification（46）· verify-shapley（36） |
| 几何与拓扑层 17.0-20.0 | verify-frontier-kernels · verify-frontier-wiring |
| 创世层 21.0-25.0 | verify-genesis-kernels（43）· verify-genesis-wiring（18） |
| 先知层 26.0-30.0 | verify-prophet-kernels（49）· verify-prophet-wiring（31） |
| 均衡层 31.0-35.0 | verify-equilibrium-kernels（58）· verify-equilibrium-wiring（26） |
| 觉醒层 36.0-40.0 | verify-awakening-kernels（33）· verify-awakening-wiring（20） |
| 川流层 41.0-45.0 | verify-flux-kernels（32）· verify-flux-wiring（15） |
| 经纬层 46.0-50.0 | verify-fabric-kernels（22）· verify-fabric-wiring |
| 奇点层 51.0-55.0 | verify-speculative-decoding（50）· verify-test-time-compute（57）· verify-whittle-index（52）· verify-lyapunov-drift（62）· verify-hawkes-process（51） |
| 心智层 56.0-60.0 | verify-belief-propagation（41）· verify-variational-langevin（47）· verify-curriculum-rd（75） |
| 博弈层 61.0-65.0 | verify-stable-matching（52）· verify-mechanism-design（34）· verify-game-kernels（80）· verify-pricing-calibration（42） |
| 突现层 66.0-70.0 | verify-stochastic-optimization（59）· verify-compression-distance（45）· verify-mapper-graph（79）· verify-partial-info-decomposition（74） |
| 证明层 71.0-75.0 | verify-search-sparse（44）· verify-online-frontier（45）· verify-genesis25-wiring（94） |
| 共生经济 | verify-symbiosis · verify-symbiosis-bridge · verify-belief-market · verify-futarchy · verify-energy-feedback · verify-full-agents · verify-observability |
| 学习与进化 | verify-self-evolution · verify-self-evolution-v2 · verify-knowledge-distillation · verify-policy-evolution · verify-meta-cognition · verify-meta-cognition-v2 · verify-meta-edge · verify-consensus-sync |

（括号内为显式断言计数；未标注者以「全部通过」收尾。）

## 如何启用

全部新内核经 `autonomy.kernels` 命名空间开启（缺省关闭）。示例（dsh 用户层 `cordis.patch.yml` 或宿主配置）：

```yaml
autonomy:
  kernels:
    noveltySentinel:
      enabled: true   # 76.0 信号「异常 = 没见过」双证据判读（观测口径）
    pomdpPlanner:
      enabled: true    # 84.0 defer/execute/ask-user 的信念规划咨询
    safetyBarrier:
      enabled: true    # 87.0 逐动作微分安全过滤（infeasible 上报总督）
    globalWorkspace:
      enabled: true    # 96.0 跨引擎意识总线（心跳旁路仲裁）
```

完整旗标与参数见 [README.md 配置节](./README.md#配置零手动配置)与 `scripts/verify-autonomy25-wiring.mjs`（每个接线点的「旗标关 = 现状 / 旗标开 = 生效」对照即活文档）。
