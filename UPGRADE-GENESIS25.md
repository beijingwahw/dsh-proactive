# 创世纪升级公告（Genesis25）：48 → 73 内核

**版本 0.6.0**（自 0.5.0 升级）。本次升级在既有四十八质变内核（3.0 → 50.0，七大层）之上新增 **五个层、25 个数学内核（51.0 → 75.0）**，并完成 13 个引擎的全链路接线。全部新内核**缺省关闭、零漂移**——不打开旗标，系统行为与升级前逐位一致。

## 升级概览

- **内核总数**：48 → **73**（`src/core/` 下 73 个内核文件，编号铺满 3.0 → 75.0）
- **新增五层**：奇点层 51–55 / 心智层 56–60 / 博弈层 61–65 / 突现层 66–70 / 证明层 71–75
- **接线**：13 个引擎（ModelScheduler / TaskExecutor / DecisionEngine / Sentinel / WorldModel / MetaCognitionEngine / StrategyEvolutionEngine / CuriosityEngine / LongTermMemory / Optimizer / BenchmarkEngine / SymbiosisBridge / Reflector）各获 `attach*` 挂载方法与只读读数方法；适配层位于 `src/engines-frontier/genesis25.ts`
- **旗标**：统一收敛于 `autonomy.kernels.<camelCase>.enabled` 命名空间，缺省全 `false`
- **验证**：19 个新验证脚本 + 1 个全链路零漂移接线脚本（合计 62 个离线验证脚本全绿，见下）

## 五大新层与 25 内核一览

### 第十一层「奇点层」51–55：算力本身成为调度对象

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 51.0 | 投机解码（[speculative-decoding.ts](./src/core/speculative-decoding.ts)） | draft-verify-accept 期望收益闭式：最优草稿长 k* 一阶边际条件、加速比 S(k)=N(k,γ)/(1+rk)、低接受率判退定理 | ModelScheduler | `kernels.speculativeDecoding` |
| 52.0 | 测试时计算（[test-time-compute.ts](./src/core/test-time-compute.ts)） | 多数票精确二项 + β-binomial 相关校正（精度天花板/有效样本数）+ 质量-算力幂律水填充 + 边际增益早停 | TaskExecutor | `kernels.testTimeCompute` |
| 53.0 | Whittle 指数（[whittle-index.ts](./src/core/whittle-index.ts)） | 不休眠 RMAB 补贴 MDP 无差异 λ 二分（可索引性显式检查 + 两态族恒可索引性定理） | ModelScheduler | `kernels.whittleIndex` |
| 54.0 | Lyapunov 漂移加罚（[lyapunov-drift.ts](./src/core/lyapunov-drift.ts)） | 背压调度 [O(1/V) 次优, O(V) 队长] 权衡定理；对偶价格 p_i=Q_i/V 收敛容量域 LP 乘子 | TaskExecutor | `kernels.lyapunovBackpressure` |
| 55.0 | Hawkes 自激发（[hawkes-process.ts](./src/core/hawkes-process.ts)） | 指数核 Hawkes EM 拟合（O(N) 链式递推）+ Ogata 时间重标残差诊断 + 爆发预测闭式 | Sentinel | `kernels.hawkesBurstGuard` |

### 第十二层「心智层」56–60：推断基础设施五件套

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 56.0 | 置信传播（[belief-propagation.ts](./src/core/belief-propagation.ts)） | 因子图 sum-product/max-product 消息传递，树上 = 精确边缘化 | WorldModel | `kernels.beliefPropagation` |
| 57.0 | 变分推断（[variational-inference.ts](./src/core/variational-inference.ts)） | CAVI 平均场：ELBO 单调可审计，共轭情形精确恢复后验 | MetaCognitionEngine | `kernels.variationalInference` |
| 58.0 | 朗之万采样（[langevin-sampling.ts](./src/core/langevin-sampling.ts)） | ULA/MALA（接受率对照 0.574）+ Bures-Wasserstein W₂ 收敛审计 | StrategyEvolutionEngine | `kernels.langevinMutation` |
| 59.0 | 课程学习（[curriculum-learning.ts](./src/core/curriculum-learning.ts)） | 掌握门限晋升状态机（Beta 后验 Wilson 下界裁决），三种子 200 种子对照 | CuriosityEngine | `kernels.curriculum` |
| 60.0 | 率失真（[rate-distortion.ts](./src/core/rate-distortion.ts)） | Blahut-Arimoto 二值源 1e-6 精确 + 记忆 keep-compress-drop 三档规划 + 影子价格 | LongTermMemory | `kernels.rateDistortion` |

### 第十三层「博弈层」61–65：共生经济的市场设计数学

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 61.0 | 稳定匹配（[stable-matching.ts](./src/core/stable-matching.ts)） | Gale-Shapley 延迟接受（无阻挡对证书）+ 稳定匹配格 + TTC 强核 | SymbiosisBridge | `kernels.stableMatching` |
| 62.0 | 机制设计（[mechanism-design.ts](./src/core/mechanism-design.ts)） | VCG 外部性定价（DSIC）+ Myerson 铁化保留价（5/12 收益对照等文献锚点） | SymbiosisBridge | `kernels.mechanismDesign` |
| 63.0 | 核仁（[nucleolus.ts](./src/core/nucleolus.ts)） | BigInt 精确有理数单纯形：抱怨向量字典序最小（核空时仍存在且唯一） | SymbiosisBridge | `kernels.nucleolusAudit` |
| 64.0 | 相关均衡（[correlated-equilibrium.ts](./src/core/correlated-equilibrium.ts)） | regret matching 无悔动态收敛 CE（交通灯协调 9.75 倍收益对照） | SymbiosisBridge | `kernels.correlatedEquilibrium` |
| 65.0 | 动态定价（[dynamic-pricing.ts](./src/core/dynamic-pricing.ts)） | 未知需求曲线下的 UCB/Thompson 学习定价，√T 遗憾（d(p)=1−p 解析锚） | SymbiosisBridge | `kernels.dynamicPricing` |

### 第十四层「突现层」66–70：整体大于部分之和可计算

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 66.0 | 模拟退火（[simulated-annealing.ts](./src/core/simulated-annealing.ts)） | Hajek 对数降温收敛条件实证 + Boltzmann-Gibbs 频率对照 + 势阱深度分析 | StrategyEvolutionEngine | `kernels.annealingEscape` |
| 67.0 | NSGA-II（[nsga2-pareto.ts](./src/core/nsga2-pareto.ts)） | 非支配排序 + 拥挤距离：前沿维持比加权 GA 铺开约 130 倍，2D 超体积单调 | ModelScheduler | `kernels.paretoFront` |
| 68.0 | 压缩距离（[compression-distance.ts](./src/core/compression-distance.ts)） | LZW/NCD 归一化压缩距离：√2−1 自距离下界定理 + 家族聚类恢复 | LongTermMemory | `kernels.compressionDistance` |
| 69.0 | Mapper 图（[mapper-graph.ts](./src/core/mapper-graph.ts)） | 滤镜-覆盖-纤维聚类-神经图骨架：圆环 H₁ 圈基 = 1 与 36.0 持续同调互证 | WorldModel | `kernels.mapperGraph` |
| 70.0 | 部分信息分解（[partial-info-decomposition.ts](./src/core/partial-info-decomposition.ts)） | BROJA PID 一次凸规划导出冗余/独占/协同四原子（XOR 纯协同 1 bit、AND 文献值 0.311）+ O 信息 | Reflector | `kernels.pidDiagnostics` |

### 第十五层「证明层」71–75：结论携带证书

| 编号 | 名称 | 一句话数学核心 | 挂载引擎 | 旗标 |
|------|------|----------------|----------|------|
| 71.0 | A* 搜索（[astar-search.ts](./src/core/astar-search.ts)） | 可采纳/一致启发式最优性定理：展开数 ≤ Dijkstra（运行时计数落账） | Optimizer | `kernels.astarSearch` |
| 72.0 | 稀疏恢复（[sparse-recovery.ts](./src/core/sparse-recovery.ts)） | Lasso 坐标下降 KKT 最优性证书（≤1e-6）+ OMP 精确支撑恢复 + CV 选 λ | Optimizer | `kernels.sparseRecovery` |
| 73.0 | 最佳臂识别（[best-arm-identification.ts](./src/core/best-arm-identification.ts)） | 固定预算 BAI：逐次减半 500 种子识别率 0.984 / H 复杂度样本分配 | BenchmarkEngine | `kernels.baiSelector` |
| 74.0 | 镜像下降（[mirror-descent.ts](./src/core/mirror-descent.ts)） | Bregman 几何无悔算子：熵镜像 = Hedge（后悔 ≤ 2√(T ln n)），三点恒等式 1e-12 | DecisionEngine | `kernels.mirrorDescent` |
| 75.0 | 在线校准（[online-calibration.ts](./src/core/online-calibration.ts)） | 在线 Platt / PAVA 保序回归 + 门控零漂移：未确证失准时输出恒等无伤害 | DecisionEngine | `kernels.onlineCalibration` |

## 零漂移承诺

本仓库的宪法：**任何新数学不得改变未启用它的行为**。创世纪升级的接线满足三层零漂移：

1. **缺省关闭**：`autonomy.kernels.*` 25 个旗标缺省全 `false`，不挂载任何新逻辑；
2. **旗标关 = 现状**：`verify-genesis25-wiring.mjs` 对 13 个引擎逐一对照——未挂载时新读数全部缺席（`undefined`），动态选型决策与对照调度器**逐位一致**（rationale 同构），探索/执行/结算的既有行为不变；
3. **挂载纪律分级**：影子口径（61.0→65.0 共生市场核不改铸币数值）、只读口径（58.0/66.0/69.0/70.0 诊断不改种群/执行）、咨询口径（51.0/52.0/56.0/71.0/74.0 读数可选采纳）、门控口径（75.0 未确证失准恒等直通）、决策口径（53.0 显式切换选型规则）。

75.0 的门控设计是零漂移的加强形态：**挂载后**只要漂移哨兵未锁存（最坏分桶 z 分数未超阈），输出置信度仍逐位不变——校准只在「确证失准」后介入。

## 验证汇总（全量 62 脚本，0 FAIL）

`npm run build` 成功；`npx tsc --noEmit` 0 错误；`scripts/` 下全部 `verify-*.mjs` 逐一运行，**62/62 通过（退出码 0，0 FAIL）**。其中 43 个脚本打印显式断言计数、合计 **1,950 项断言**；其余 19 个以「全部通过」收尾。

### 创世纪新脚本（19 + 1 接线）

| 脚本 | 覆盖 | 断言数 | 结果 |
|------|------|--------|------|
| verify-speculative-decoding | 51.0 | 50 | PASS |
| verify-test-time-compute | 52.0 | 57 | PASS |
| verify-whittle-index | 53.0 | 52 | PASS |
| verify-lyapunov-drift | 54.0 | 62 | PASS |
| verify-hawkes-process | 55.0 | 51 | PASS |
| verify-belief-propagation | 56.0 | 41 | PASS |
| verify-variational-langevin | 57.0 + 58.0 | 47 | PASS |
| verify-curriculum-rd | 59.0 + 60.0 | 75 | PASS |
| verify-stable-matching | 61.0 | 52 | PASS |
| verify-mechanism-design | 62.0 | 34 | PASS |
| verify-game-kernels | 63.0 + 64.0 | 80 | PASS |
| verify-pricing-calibration | 65.0 + 75.0 | 42 | PASS |
| verify-stochastic-optimization | 66.0 + 67.0 | 59 | PASS |
| verify-compression-distance | 68.0 | 45 | PASS |
| verify-mapper-graph | 69.0 | 79 | PASS |
| verify-partial-info-decomposition | 70.0 | 74 | PASS |
| verify-search-sparse | 71.0 + 72.0 | 44 | PASS |
| verify-online-frontier | 73.0 + 74.0 | 45 | PASS |
| verify-genesis25-wiring | 51.0→75.0 全链路接线零漂移 | 94 | PASS |

### 存量脚本（43）

| 脚本 | 断言数 | 结果 |
|------|--------|------|
| verify-abstraction | 40 | PASS |
| verify-active-inference | 49 | PASS |
| verify-anytime-evidence | 24 | PASS |
| verify-awakening-kernels | 33 | PASS |
| verify-awakening-wiring | 20 | PASS |
| verify-belief-market | —（全部通过） | PASS |
| verify-causal-kernel | 50 | PASS |
| verify-conformal | 32 | PASS |
| verify-consensus-sync | —（全部通过） | PASS |
| verify-deliberation | 53 | PASS |
| verify-energy-feedback | —（全部通过） | PASS |
| verify-equilibrium-kernels | 58 | PASS |
| verify-equilibrium-wiring | 26 | PASS |
| verify-fabric-kernels | 22 | PASS |
| verify-fabric-wiring | 14 | PASS |
| verify-flux-kernels | 32 | PASS |
| verify-flux-wiring | 15 | PASS |
| verify-frontier-kernels | —（全部数学验证通过） | PASS |
| verify-frontier-wiring | —（接线冒烟全部通过） | PASS |
| verify-full-agents | —（全部通过） | PASS |
| verify-futarchy | —（全部通过） | PASS |
| verify-genesis-kernels | 43 | PASS |
| verify-genesis-wiring | 18 | PASS |
| verify-knowledge-distillation | —（全部通过） | PASS |
| verify-meta-cognition | —（全部通过） | PASS |
| verify-meta-cognition-v2 | —（全部通过） | PASS |
| verify-meta-edge | —（全部通过） | PASS |
| verify-metareasoning | 43 | PASS |
| verify-observability | —（全部通过） | PASS |
| verify-policy-evolution | —（全部通过） | PASS |
| verify-prophet-kernels | 49 | PASS |
| verify-prophet-wiring | 31 | PASS |
| verify-quality-diversity | 28 | PASS |
| verify-resilience-governance | —（全部通过） | PASS |
| verify-runtime-verification | 46 | PASS |
| verify-scientist | 54 | PASS |
| verify-self-evolution | —（全部通过） | PASS |
| verify-self-evolution-v2 | —（全部通过） | PASS |
| verify-shapley | 36 | PASS |
| verify-symbiosis | —（全部通过） | PASS |
| verify-symbiosis-bridge | —（全部通过） | PASS |
| verify-theorist | 51 | PASS |
| verify-unified-evidence | —（全线贯通） | PASS |

## 如何启用

全部新内核经 `autonomy.kernels` 命名空间开启（缺省关闭）。示例（dsh 用户层 `cordis.patch.yml` 或宿主配置）：

```yaml
autonomy:
  kernels:
    speculativeDecoding:
      enabled: true   # 51.0 投机解码配对经济裁决
    whittleIndex:
      enabled: true   # 53.0 动态选型切换 RMAB 口径
    onlineCalibration:
      enabled: true   # 75.0 概率口径前置层（门控恒等无伤害）
```

完整旗标与参数见 [README.md 配置节](./README.md#配置零手动配置)与 `scripts/verify-genesis25-wiring.mjs`（每个接线点的「旗标关 = 现状 / 旗标开 = 生效」对照即活文档）。
