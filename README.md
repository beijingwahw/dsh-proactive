# dsh-proactive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)](#安装)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)](https://github.com/topics/dsh-plugin)

> **主动智能（Proactive Intelligence）调度插件** —— DeepSeek Harness（DSH）生态中的多模型协同调度系统：自主感知、自主决策、自主进化，内置**科学家 / 理论家双心智**、**认知能量共生经济**与**四十八质变内核（证据 → 几何拓扑 / 创世 / 先知 / 均衡 / 觉醒 / 川流 / 经纬层：任意时刻有效 / 保形 / 最优传输 / 信息几何 / 层论共识 / Gittins / 稳健统计 / 差分隐私 / 容量规划 / 高斯过程 / 卡尔曼滤波 / 极值理论 / 蒙特卡洛树搜索 / 次模优化 / 对抗无悔学习 / 匈牙利全局指派 / 随机矩阵 / CVaR 分布鲁棒 / LQR 反馈控制 / 持续同调 / 信息瓶颈 / 非线性动力学 / PageRank 谱排序 / 首达时间 / Jackson 排队网络 / FFT 谱周期 / 最大流 / 极大极小公平 / OCBA 预算分配 / 法定人数交叉 / CRDT 收敛 / Shamir 秘密共享 / Haar 小波 / 低秩矩阵补全）**。
>
> [English](./README.en.md) | 中文

## 什么是主动智能？

传统调度系统是**被动的**：收到信号才响应，没有信号就空转。本插件在「感知 → 决策 → 执行 → 反思 → 沉淀」闭环之上叠加自主层，让系统：

- **没有任务时**，主动观察自身运行状态、发现瓶颈、生成改进目标
- **遇到未知领域**，主动发起探索，把"不知道"变成"有经验"
- **面对未来负载**，主动预测信号到达趋势，提前预留容量
- **出现异常时**，主动熔断、限流、降级，而不是等到崩溃

## 架构总览

系统由三层组成：**质变内核**（一套共享统计语言的心智底座）、**三环自治**（操作环 / 进化环 / 元认知外环）、**共生经济层**（认知能量市场）。

```
┌─ 共生经济层（symbiosis/）─────────────────────────────────────┐
│  能量账本（复式记账·链式审计）  知识市场（连续双向拍卖·版税）      │
│  信念市场（LMSR·市场即心智）    智能体（信誉·立法执法分离）       │
│  共生运行时（生存→提案→否决→撮合→执行·铸币分红）                 │
├─ 三环自治 ───────────────────────────────────────────────────┤
│  操作环：信号→决策→执行→反思 10 步主链路（index.ts）             │
│  进化环：策略进化器 + 安全沙盒 + 金丝雀部署（policy/）            │
│  元认知外环：自我建模 → 保守调整 → 观察/回滚（meta/）             │
├─ 质变内核（core/）3.0 → 50.0 四十八内核 ─────────────────────┤
│  证据 3.0  弹性 4.0  因果 5.0  自由能 6.0  深思 7.0             │
│  元推理 8.0  抽象 9.0  科学家 10.0  理论家 11.0                 │
│  任意时刻证据 12.0  保形预测 13.0  质量-多样性 14.0              │
│  运行时验证 15.0  Shapley 归因 16.0                             │
│  最优传输 17.0  信息几何 18.0  最优停止 19.0  层论共识 20.0      │
│  Gittins 21.0  预算 Knapsack 22.0（创世层）                    │
│  稳健统计 23.0  差分隐私 24.0  容量规划 25.0（创世层）           │
│  高斯过程 26.0  卡尔曼滤波 27.0  极值理论 28.0（先知层）         │
│  蒙特卡洛树搜索 29.0  次模优化 30.0（先知层）                    │
│  对抗无悔学习 31.0  全局指派 32.0  随机矩阵 33.0（均衡层）       │
│  CVaR 分布鲁棒 34.0  LQR 反馈控制 35.0（均衡层）                 │
│  持续同调 36.0  信息瓶颈 37.0  非线性动力学 38.0（觉醒层）       │
│  PageRank 谱排序 39.0  首达时间 40.0（觉醒层）                   │
│  Jackson 排队网络 41.0  FFT 谱周期 42.0  最大流 43.0（川流层）   │
│  极大极小公平 44.0  OCBA 预算分配 45.0（川流层）                 │
│  法定人数 46.0  CRDT 47.0  Shamir 共享 48.0（经纬层）           │
│  Haar 小波 49.0  矩阵补全 50.0（经纬层）                        │
└──────────────────────────────────────────────────────────────┘
```

## 核心特性

### 主动感知与自主决策
- Sentinel 多源信号接入（webhook / 文件监听 / 轮询 / 手动注入），聚合窗口去重、紧急度智能排序
- 战略决策引擎：execute / defer / dismiss / ask-user 四级决策，统计学习（时间衰减 + Wilson 下界 + UCB 冷启动）持续校准
- 经验检索 + DAG 计划生成 + 多模型并行执行，10 步主链路单向数据流

### 科学家 / 理论家双心智
- **科学家内核**（[core/scientist.ts](./src/core/scientist.ts)）：贝叶斯最优实验设计——为「知识获取本身」定价。真 EIG（nat）评估实验信息价值、混杂加成（实验独占价值）、预算仲裁（netValue = EIG − cost）、信息台账校准、知识前沿收缩
- **理论内核**（[core/theorist.ts](./src/core/theorist.ts)）：层级贝叶斯 + MDL（理解即压缩）——把数据压缩为定律。同族观测边汇聚为定律（借力收缩）、压缩定价（对数贝叶斯因子）、零样本预测、反常侦测、范式转移（库恩跃迁）

### 任意时刻证据 / 保形 / 多样性 / 形式安全 / 公平归因（12.0 → 16.0）
- **任意时刻证据内核**（[core/anytime-evidence.ts](./src/core/anytime-evidence.ts)）：置信序列 + e-过程——**任何时刻偷看都合法**。时间一致置信区间（缝合 CS）随时读取随时有效；e-过程资本以 Ville 不等式裁决假设，多基因组淘汰经 e-BH 过程获得 FDR 上限（冤案率有数学保证）；元认知 KPI 保证层挂载后，退化/恢复判定升级为情节化状态机（水位线两侧各自积累证据，越线即重置——偷看免疫、恢复可判）
- **保形预测内核**（[core/conformal.ts](./src/core/conformal.ts)）：分布无关精确覆盖——**零分布假设的预测区间**。分裂保形区间给出有限样本精确保证（P(实际 ∈ 区间) ≥ 1−α）；覆盖漂移监视器以可预测 λ 下注的 e-过程侦测失准；阈值自校准升级为风险受控选择（经验伯恩斯坦上界 + Bonferroni，P(未来重试率 ≤ 目标) ≥ 置信水平）
- **质量-多样性内核**（[core/quality-diversity.ts](./src/core/quality-diversity.ts)）：MAP-Elites 行为归档——**多样性坍缩被结构性阻断**。策略基因按行为描述子（敢为/节俭/警觉三维）落入 niche 网格，各流派获得等量试验预算（前沿均匀采样）；QD-score 同时度量质量与覆盖，进化不再收敛到单一解
- **运行时验证内核**（[core/runtime-verification.ts](./src/core/runtime-verification.ts)）：LTLf 规约监视——**安全规约形式化，裁决携带证明**。缺省规约集（无失败风暴 / 命令必响应 / 周期心跳 / 先授权后执行）编译为四类监视器原子；违规报告含完整证据轨迹与反例见证；severity 分级升级（critical → Kill Switch、warn → 熔断、info → 审计）
- **Shapley 归因内核**（[core/shapley.ts](./src/core/shapley.ts)）：公理化公平分配——**贡献拆账有数学定理背书**。效率/对称/哑元/可加四公理精确满足；置换采样 + 任意时刻有效置信区间（边采样边出置信界，停不停都有保证）；协同侦测自动识别 1+1>2 的正协同与搭便车的负协同

### 最优传输 / 信息几何 / 最优停止 / 层论共识（17.0 → 20.0）
- **最优传输内核**（[core/optimal-transport.ts](./src/core/optimal-transport.ts)）：Wasserstein 距离 + Sinkhorn——**漂移检测看见分布的形状**。一维精确 W₁（分位数耦合，O(n log n)）、对数域稳定化 Sinkhorn（任意代价矩阵）、Wasserstein 重心（保留形状的分布融合）；形状感知漂移监视器（滑动窗 vs 不相交基准窗 + 历史分位自适应阈值）挂载元认知后——**均值不变而形状巨变的「换了世界」第一次可见**（12.0 水位检测的盲区补位、13.0 保形区间的绊线）
- **信息几何内核**（[core/information-geometry.ts](./src/core/information-geometry.ts)）：Fisher 度量 + KL 信任域——**进化在流形上行走**。策略变异从坐标轴独立加噪升级为种群协方差主轴展开的联合相关步（有利基因组合完整传递）；步长以 nat 计价（KL 信任域 Mahalanobis 封顶），**仿射重参数化下严格不变**（数值验证：坐标缩放 100×/0.01× 后步长 6 位小数不变）；条件数 / 有效维数（参与比）让搜索几何本身成为可观测对象
- **最优停止内核**（[core/optimal-stopping.ts](./src/core/optimal-stopping.ts)）：先知不等式 + 向后归纳——**等待有了数学价格**。经验分布上的精确停止价值递推（V_k = E[max(X, V_{k+1})]）、先知基准（次序统计量精确计算 E[max]）、Samuel-Cahn 单阈值规则（任意分布 ≥ ½ 先知保证）、秘书 1/e 规则与 Bruss 赔率算法；决策引擎规则 C 挂载后，**高成本信号的 defer/execute 从「urgency < 0.3」魔数升级为继续价值裁决**（现值 ≥ V_{horizon} 即执行——占坑数学最优，否则等待有价）
- **层论共识内核**（[core/sheaf-consensus.ts](./src/core/sheaf-consensus.ts)）：胞腔层拉普拉斯 + 调和共识——**分歧的形状可见**。「谁与谁、在哪些声明上应该一致」成为一等数学对象（顶点 stalk + 边限制映射）；加权调和共识（软调解解 + 完美共识流形最优拟合双解口径）输出共识指派、各源翻供距离（离群者定位）与**结构性障碍检测**——0.9/0.1/0.5 的循环硬约束下平均化会说 0.5 皆大欢喜，本内核说「无解，先解决矛盾」；`sheaf_consensus` Tool 让大模型在推理时直接调用结构化信念融合

### 最优索引调度 / 预算最优路由（21.0 → 22.0）
- **最优索引调度内核**（[core/index-scheduling.ts](./src/core/index-scheduling.ts)）：Gittins 指数精确计算——**模型调度第一次有了可证明最优的口径**。对每个候选的 Beta 后验求解折扣 bandit 最优索引（退休 MDP 在 (α,β) 三角形上按 n 反向归纳一遍即得全部 V_R，无需不动点迭代；对无差异退休金二分），调度按 ν × availability 排序；学习溢价 = ν − p̂ 随证据积累自动归零（探索自我终结，不再需要手设探索预算），与 UCB 乐观上界启发式的本质区别是最优性有定理背书
- **预算最优路由内核**（[core/bandit-knapsack.ts](./src/core/bandit-knapsack.ts)）：Bandits with Knapsacks——**预算约束下的最优路由，影子价格内生涌现**。质量走经验伯恩斯坦乐观上界（复用 12.0），可行性按「剩余预算 / 剩余轮数 × (1+slack)」判定，影子价格 λ 从不可行高质臂与选中臂的混合 LP 顶点实时解出（固定 costWeight 只是 λ 的一次性猜测）；无可行臂时选最廉臂止血并标记 urgent（负载卸载，而非假装最优仍存在）

### 创世层（23.0 → 25.0）
- **稳健统计内核**（[core/robust-statistics.ts](./src/core/robust-statistics.ts)）：Catoni 估计 + Median-of-Means——**重尾延迟下均值不再被尾部绑架**。仅有限方差假设即得 sub-Gaussian 型置信界（普通均值被 5% 污染 × 1e6 幅度的尾部搬到 50000，Catoni 压回 2.69——四个数量级的抗性）；每模型延迟流随样本量自适应 mean → MoM → Catoni，启用后 `getModelStatuses` 输出 `robustAvgLatencyMs`
- **差分隐私内核**（[core/differential-privacy.ts](./src/core/differential-privacy.ts)）：Laplace/Gaussian 机制 + Rényi-DP 记账——**遥测不裸暴露个体**。折半分账永不超支（Σε ≤ ε），id/时间戳自动跳过，RDP→(ε,δ) 解析转换；心智报告 / Sankey 能量流启用后数值叶经扰动发布
- **容量规划内核**（[core/capacity-planning.ts](./src/core/capacity-planning.ts)）：Erlang-C / Kingman 反解——**并发上限第一次从排队论里算出来**。心跳 2.5 段把世界模型预测到达率 × 稳健平均延迟喂入排队论规划器，反解「守住目标等待时间」的最小并发；不可行（ρ≥1）时诚实返回 infeasible 并建议扩容/降载

### 先知层（26.0 → 30.0）
- **高斯过程内核**（[core/gaussian-process.ts](./src/core/gaussian-process.ts)）：RBF/Matérn 贝叶斯回归 + 期望改进——**预测偏差本身成为可学习的曲线**。世界模型校准史的 actual/predicted 比值序列经 GP 回归给出带不确定度的乘性修正因子（趋势修正的 1.25/0.75 魔数由对账结果接管）；EI 采集函数（解析式与蒙特卡洛对照）支撑离散候选集上的贝叶斯优化
- **卡尔曼滤波内核**（[core/kalman-filter.ts](./src/core/kalman-filter.ts)）：局部线性趋势滤波 + RTS 平滑 + NIS 门控——**突变判定从启发式升级为假设检验**。KPI 整条历史压进 (level, slope) 充分统计量，新息平方和超出 χ²(1) 99.7% 分位才报警（99.7% 不该发生的才算异常），缓慢漂移由滤波斜率早期读出；随机游走稳态与闭式 P∞=(√(q²+4qr)−q)/2 精确对照
- **极值理论内核**（[core/extreme-value.ts](./src/core/extreme-value.ts)）：POT/GPD + Hill 估计——**p99.9 不再是「样本最大值」的运气**。Pickands–Balkema–de Haan 定理保证超阈值超出量收敛于 GPD，Grimshaw 剖面似然一维搜索定参，尾部分位数定理化外推（含 bootstrap CI）；心跳 2.7 段对延迟样本评估尾部风险，超出目标产出 tail-risk 洞察
- **蒙特卡洛树搜索内核**（[core/mcts.ts](./src/core/mcts.ts)）：UCT + 折扣回报——**搜索预算的分配本身成为序贯决策**。转移边按 Beta 后验采样成败，UCB1 平衡利用/探索，节点本地回报回传（无深度偏置），迭代/时间预算耗尽即读出（任意时刻性）；深思引擎 `searchMcts` 与 beam search 同口径互查
- **次模优化内核**（[core/submodular.ts](./src/core/submodular.ts)）：加权覆盖 + 惰性贪心（CELF）——**探索预算的分配第一次有近似比保证**（≥ (1−1/e)·OPT，Nemhauser–Wolsey–Fisher）。知识项自身为主题、相似项部分覆盖：冗余第二选的边际衰减到 (1−c)·w，互补盲区优先入选；曲率修正把保证收紧到 (1−e^{−c})/c·OPT

### 均衡层（31.0 → 35.0）

> 先知层预测世界的未来；**均衡层承认世界会反击**——对手、全局约束、噪声、最坏情况、反馈失稳。五个数学支柱把调度系统从「预测最优」升维到「对抗均衡」。

- **在线学习内核**（[core/online-learning.ts](./src/core/online-learning.ts)）：Fixed-Share Hedge——**对手无论怎么出招都不后悔**。系统里一切统计学习（Wilson / UCB / Gittins）都假设世界是平稳概率分布；本内核叠加对抗口径：模型评分乘以有界 Hedge 乘数（[0.25,4]），对事后最优固定模型的遗憾 ≤ √(2T lnN)（Freund–Schapire，分布假设无关）；α 份额回灌保证模型能力翻转可跟踪（Herbster–Warmuth），被打爆的模型以每失败一轮 e^{−η} 的速度降权——比统计口径快一个数量级
- **全局指派内核**（[core/optimal-assignment.ts](./src/core/optimal-assignment.ts)）：匈牙利算法（Jonker–Volgenant O(n³)）——**批内选型从局部贪心到全局最优**。同批动态选型节点构造「节点 × 候选」评分矩阵求线性和指派精确解：最优模型不再被同批节点重复超订、次优不再闲置；**对偶证书**（u_i+v_j ≤ c_ij + 互补松弛 + 零间隙）让最优性可被逐位检查而非被声称（与 15.0 同一「证明携带」哲学）
- **随机矩阵内核**（[core/random-matrix.ts](./src/core/random-matrix.ts)）：Marchenko–Pastur 噪声边界 + 特征值清洗——**相关性从统计幻觉升级为可证伪的结构断言**。模型失败序列的样本相关矩阵大部分谱结构是纯噪声（MP 带）；循环 Jacobi 特征分解 + Laloux/Bouchaud 清洗把伪相关吸收进噪声带（不误报），头号特征值显著超带且解释份额达标 → systemic-risk 洞察：同厂商/同上游的模型会同沉浮，「看起来分散」的热备冗余是幻觉
- **分布鲁棒内核**（[core/robust-decisions.ts](./src/core/robust-decisions.ts)）：CVaR + Wasserstein 球——**最坏情况有了闭式价格**。超时预算 = margin × CVaR_α(该模型延迟史)（Rockafellar–Uryasev 精确式，相干风险度量四公理背书）：重尾模型自动获得更长预算、轻尾模型不被一刀切；Wasserstein-1 鲁棒均值是 KR 对偶的代数恒等式（sup = E + ε），超越概率的球内最坏化有精确有限样本算法
- **反馈控制内核**（[core/feedback-control.ts](./src/core/feedback-control.ts)）：离散 LQR + Lyapunov 证书——**并发上限的闭环驾驭**。25.0 排队论反解给出静态目标，本内核让 computeParallelism 成为追踪目标的反馈控制器：增益从 DARE 闭式解出（与不动点迭代逐位对账），闭环每一步的稳定性被李雅普诺夫函数**证明**（V(e_{k+1}) − V(e_k) = −(qe²+ru²) 到机器精度）；死区抗抖振、钳位抗饱和，AIMD 式启发式调参退役

### 觉醒层（36.0 → 40.0）

> 均衡层与世界博弈；**觉醒层看见自己的形状**——知识的拓扑、蒸馏的信息价格、KPI 的动力学体质、影响力的结构涌现、恢复等待的概率定价。五个数学支柱把「自我认知」从报告口径升维为可计算的数学对象。

- **持续同调内核**（[core/persistent-homology.ts](./src/core/persistent-homology.ts)）：H₀ 持续图 + 瓶颈距离——**知识的形状跨尺度可见**。共现权重视为相似度、阈值扫描给出大陆（稳定知识簇）/孤岛（与任何主题不共现的记忆——盲区的拓扑定义）；瓶颈距离带 Cohen-Steiner–Edelsbrunner–Harer 稳定性定理（输入扰动 δ ⟹ 地形漂移 ≤ δ）。`query_memory` 新增 `topology` 动作直接查询知识地形
- **信息瓶颈内核**（[core/information-bottleneck.ts](./src/core/information-bottleneck.ts)）：Blahut–Arimoto / Tishby——**蒸馏的信息论定价**。X = 任务位型、Y = 成败，IB 最优压缩的保留率 I(T;Y)/I(X;Y) 是「这批样本携带多少值得蒸馏的新信息」：同构批（保留率 < 下限或 I(X;Y) < 0.05 nat）诚实跳过——水位再高也只产出重复知识；数据处理不等式保证保留率 ≤ 1（三次确定性重启逃离硬指派冻结）
- **非线性动力学内核**（[core/nonlinear-dynamics.ts](./src/core/nonlinear-dynamics.ts)）：Rosenstein Lyapunov + R/S Hurst——**KPI 的体质分类**。混沌（λ₁ > 0，最近邻可预测性门控排除白噪声伪混沌）→ 预测视野 ~1/λ₁ 步；持续（H > 0.5）→ 趋势加权；反持续（H < 0.5）→ 突破降权；logistic 映射 λ₁ = ln2 解析对照
- **谱排序内核**（[core/spectral-ranking.ts](./src/core/spectral-ranking.ts)）：PageRank 幂迭代——**知识图的影响力从结构涌现**。「被重要者共现者重要」写成不动点，线性收敛 + 质量守恒可逐位检查；related() 联想序升维为「边权 × 邻居影响力」，topInfluential 输出知识骨架（蒸馏保骨去肉的依据）；环图精确均匀是验证锚点
- **首达时间内核**（[core/first-passage.ts](./src/core/first-passage.ts)）：反射原理 + 逆高斯 + 赌徒破产——**熔断恢复的概率定价**。失败间隔的漂移/波动喂入首达模型，二分解出「以 target 概率确信失败强度已恢复」的最小冷却；μ̂ ≤ 0 的结构性恶化诚实给出不可达；Brownian 反射恒等式与 2 万路径模拟对照

### 川流层（41.0 → 45.0）

> 先知预见、均衡博弈、觉醒自视；**川流层让吞吐、周期、公平与预算成为流数学的对象**——瓶颈站在哪、节律是什么、上限被谁钳制、名额怎么分、确认花给谁，五个经典问题五个定理背书。

- **排队网络内核**（[core/queueing-network.ts](./src/core/queueing-network.ts)）：Jackson 乘积形式 + Erlang-C——**瓶颈站第一次可算**。25.0 反解单站并发；41.0 把各模型作为独立 M/M(c) 站（乘积形式下边际独立），心跳 2.9 段解出 ρ 最大的瓶颈站——「其他站再快也无济于事」的钳制者。验证：12 万事件串联 M/M/1 模拟对照端到端逗留解析值 8/3、稳态队长边际相关性 ≈ 0
- **谱周期内核**（[core/spectral-periodicity.ts](./src/core/spectral-periodicity.ts)）：FFT 周期图 + Fisher g 检验——**节律从数据里解出来**。时段热度是「周期被预设为一天」的直方图；radix-2 FFT + Fisher g 精确分布让任意周期（分钟回环/昼夜/周节律）成为假设检验，显著时相位感知的谐波季节因子接管预测。验证：FFT 往返恒等、Parseval、注入周期恢复、白噪声不显著
- **最大流内核**（[core/max-flow.ts](./src/core/max-flow.ts)）：Edmonds-Karp + 最小割证书——**吞吐上限与钳制者同时可算**。类型需求 × 模型容量的流网络上，max-flow = 可立即满足的最大并发派发，min-cut 指认钳制者（类型在饿还是模型是独木桥）；割容量 = 流值是 Ford-Fulkerson 证书（与 15.0/32.0 同一「证明携带」哲学）。验证：随机 200 例与穷举最小割同解
- **公平分配内核**（[core/fair-division.ts](./src/core/fair-division.ts)）：加权极大极小注水——**没有谁被饿死是定理**。探索预算按任务家族分配从「新颖度赢者通吃」升级为 progressive filling（Bertsekas–Gallager 词典序最优 + 整数保底）：热门家族可以多拿，但任何活跃家族的相对份额不被压扁。验证：教科书注水解 [4/3,4/3,4/3,1] 与公平支配性审计
- **预算分配内核**（[core/budget-allocation.ts](./src/core/budget-allocation.ts)）：OCBA 最优计算预算——**找瓶颈的每一步都花在刀刃上**。基准重跑预算从均匀升级为 Chen et al. 闭式分配（n_i ∝ (σ_i/δ_i)²），P(正确选中瓶颈) 的指数衰减率最优（Glynn–Juneja）；报告附加 bottleneckFocus。验证：Monte Carlo P(CS) OCBA ≥ 均匀

### 经纬层（46.0 → 50.0）

> 川流层让吞吐成为流数学；**经纬层编织系统的底层织物**——共识的交叉、副本的收敛、密钥的分形、尺度的分解、能力的潜维度。五个支柱落在最后五个未升级的模块上。

- **法定人数内核**（[core/quorum-systems.ts](./src/core/quorum-systems.ts)）：quorum 交叉 + 拜占庭 3f+1 下界——**共识安全性被检查而非被相信**。多数派最小交集闭式 2q−n 与穷举枚举逐位一致；Raft `quorumAudit()` 在真实集群配置上输出交叉/容错/负载读数；n ≤ 3f 时诚实判不可行（不存在性定理）
- **无冲突复制内核**（[core/crdt.ts](./src/core/crdt.ts)）：CRDT 三定律——**副本收敛是代数性质**。G-Counter/OR-Set/LWW 的合并满足交换/结合/幂等 ⟹ 乱序+重复 gossip 后状态逐位一致（Shapiro 强最终一致性定理）；DistributedSync 的 CRDT 通道双实例实测收敛
- **秘密共享内核**（[core/secret-sharing.ts](./src/core/secret-sharing.ts)）：Shamir 阈值 + 随机性审计——**信任被分形，密钥被检验**。任意 t 份枚举重建精确成功、t−1 份信息论零泄露（重建值随机等可能）；CryptoEngine `shardKey/combineKeyShares` 真实分形；NIST 频数+游程审计密钥原料
- **多尺度内核**（[core/multiscale-wavelet.ts](./src/core/multiscale-wavelet.ts)）：Haar 小波——**慢漂移与快突发在不同尺度上分离**。正交分解（完美重构 + Parseval 能量守恒到机器精度）给出趋势水平/漂移带能量/瞬时突发的尺度读数；元认知 `waveletView` 挂载后可读
- **矩阵补全内核**（[core/matrix-completion.ts](./src/core/matrix-completion.ts)）：ALS 低秩潜因子——**冷启动能力从潜维度涌现**。「模型 × 任务」能力矩阵部分观测经交替最小二乘补全（Candès–Recht 恢复条件），未测类型的能力由潜因子外推；调度器 `coldStartEstimate` 让新模型选型从零样本升级为潜维度预测

### 质变内核（core/，3.0 → 50.0）
| 内核 | 版本 | 一句话 |
|------|------|--------|
| evidence.ts | 3.0 | 统一证据语言：Wilson 界 / 时间衰减 / 证据排序，铺满所有记忆层 |
| resilience.ts | 4.0 | 弹性执行：熔断器状态机 / 指数退避全抖动 / 错误分型 |
| causal-kernel.ts | 5.0 | 因果推断：Pearl do-干预 ATE / 混杂检测 / 反事实查询 |
| free-energy.ts | 6.0 | 主动推断：Friston 自由能，一公式统一利用/探索/好奇心/健康度 |
| deliberation.ts | 7.0 | 规划即推断：想象推演 + beam search × 技能宏 + 梦实现对账 |
| metareasoning.ts | 8.0 | 理性元推理：双过程仲裁 / 任意时搜索稳定停机 / 思考按 nat 计价 |
| abstraction.ts | 9.0 | 抽象泛化：状态骨架分解 + 结构类比，经验跨域「举一反三」 |
| scientist.ts | 10.0 | 科学家心智：贝叶斯最优实验设计（见上） |
| theorist.ts | 11.0 | 理论心智：层级贝叶斯 + MDL 定律归纳（见上） |
| anytime-evidence.ts | 12.0 | 任意时刻证据：置信序列 + e-过程 + e-BH FDR（见上） |
| conformal.ts | 13.0 | 保形预测：分布无关区间 + 风险受控阈值（见上） |
| quality-diversity.ts | 14.0 | 质量-多样性：MAP-Elites 行为归档（见上） |
| runtime-verification.ts | 15.0 | 运行时验证：LTLf 规约监视 + 证明携带裁决（见上） |
| shapley.ts | 16.0 | Shapley 归因：公理化公平分配 + 任意时刻置信区间（见上） |
| optimal-transport.ts | 17.0 | 最优传输：Wasserstein 漂移 + Sinkhorn + 重心（见上） |
| information-geometry.ts | 18.0 | 信息几何：Fisher 度量自然变异 + KL 信任域（见上） |
| optimal-stopping.ts | 19.0 | 最优停止：先知不等式 + 向后归纳 + 机会停止器（见上） |
| sheaf-consensus.ts | 20.0 | 层论共识：胞腔层拉普拉斯 + 调和共识 + 障碍检测（见上） |
| index-scheduling.ts | 21.0 | 最优索引调度：Gittins 指数精确计算（退休 MDP 三角形反向归纳），可证明最优模型调度 |
| bandit-knapsack.ts | 22.0 | 预算最优路由：Bandits with Knapsacks，影子价格从预算稀缺性内生涌现 |
| robust-statistics.ts | 23.0 | 稳健统计：Catoni + MoM（重尾下 sub-Gaussian 置信界，见上） |
| differential-privacy.ts | 24.0 | 差分隐私：Laplace/Gaussian 机制 + RDP 记账（见上） |
| capacity-planning.ts | 25.0 | 容量规划：Erlang-C / Kingman 反解最小并发 + Little 定律自检（见上） |
| gaussian-process.ts | 26.0 | 高斯过程：RBF/Matérn 回归 + EI 贝叶斯优化（预测偏差可学习，见上） |
| kalman-filter.ts | 27.0 | 卡尔曼滤波：局部线性趋势 + RTS 平滑 + NIS 门控（见上） |
| extreme-value.ts | 28.0 | 极值理论：POT/GPD 尾部外推 + Hill 估计 + 风险度量（见上） |
| mcts.ts | 29.0 | 蒙特卡洛树搜索：UCT + 折扣回报 + 任意时刻可读（见上） |
| submodular.ts | 30.0 | 次模优化：加权覆盖 + CELF 惰性贪心 + 曲率修正保证（见上） |
| online-learning.ts | 31.0 | 在线学习：Fixed-Share Hedge，对手无关遗憾 ≤ √(2T lnN)（见上） |
| optimal-assignment.ts | 32.0 | 全局指派：匈牙利 O(n³) 精确解 + 对偶最优性证书（见上） |
| random-matrix.ts | 33.0 | 随机矩阵：Marchenko–Pastur 清洗 + 系统性风险监视（见上） |
| robust-decisions.ts | 34.0 | 分布鲁棒：CVaR 精确式 + Wasserstein KR 对偶（见上） |
| feedback-control.ts | 35.0 | 反馈控制：DARE 闭式增益 + Lyapunov 稳定证书（见上） |
| persistent-homology.ts | 36.0 | 持续同调：H₀ 持续图 + 瓶颈距离稳定性（见上） |
| information-bottleneck.ts | 37.0 | 信息瓶颈：Blahut-Arimoto，蒸馏保留率定价（见上） |
| nonlinear-dynamics.ts | 38.0 | 非线性动力学：Lyapunov + Hurst 体质分类（见上） |
| spectral-ranking.ts | 39.0 | 谱排序：PageRank 幂迭代 + 知识骨架（见上） |
| first-passage.ts | 40.0 | 首达时间：反射原理 + 逆高斯冷却定价（见上） |
| queueing-network.ts | 41.0 | 排队网络：Jackson 乘积形式 + 瓶颈站（心跳 2.9 段） |
| spectral-periodicity.ts | 42.0 | 谱周期：FFT 周期图 + Fisher g 检验（谱日历） |
| max-flow.ts | 43.0 | 最大流：Edmonds-Karp + 最小割证书（容量前沿） |
| fair-division.ts | 44.0 | 公平分配：加权极大极小注水（探索家族预算） |
| budget-allocation.ts | 45.0 | OCBA：最优计算预算（基准瓶颈聚焦） |
| quorum-systems.ts | 46.0 | 法定人数：quorum 交叉 + 拜占庭 3f+1 下界（Raft 安全审计） |
| crdt.ts | 47.0 | CRDT：G-Counter/OR-Set/LWW 收敛三定律（分布式同步通道） |
| secret-sharing.ts | 48.0 | 秘密共享：Shamir 阈值 + 随机性审计（密钥分形） |
| multiscale-wavelet.ts | 49.0 | 小波：Haar 多尺度分解（KPI 尺度透镜） |
| matrix-completion.ts | 50.0 | 矩阵补全：ALS 低秩潜因子（冷启动能力外推） |

### 认知能量共生经济（symbiosis/）
- **能量账本**（ledger.ts）：认知能量不可伪造，复式记账全局守恒，每笔转账 sha256 链式可审计可回放，基尼系数度量生态健康
- **知识市场**（market.ts）：知识作为可交易资产，连续双向拍卖；挂单费燃烧防垃圾、央行支付售后版税，劣质知识被证据校准自然淘汰
- **信念市场**（belief.ts）：LMSR 做市商把「对未来的判断」变成可交易资产，市场即心智；知情者套利错者，结算即审计，激励相容
- **智能体契约**（agent.ts）：感知/提案/执行三段分离（立法-执法分离），信誉复用 Wilson 下界——贡献决定分红，表现差自然饿死休眠
- **共生运行时**（runtime.ts）：心跳编排（生存→感知→提案→监管否决→撮合→授权执行），任务成功铸币按 Wilson 加权分红，余额低于生存线休眠，监管一票否决；**影子模式接入，不接管主链路**
- **宿主融合桥**（bridge.ts）：KPI 注入能量经济、任务结算铸币分红、futarchy 进化表决三个薄接点，缺省关闭零漂移
- **首批智能体**（wrappers.ts）：MemoryAgent（卖方+维护者）/ OptimizerAgent（买方）/ EvolverAgent（策略基因卖方），构成最小认知经济闭环
- **可观测性**（observability.ts）：账本凭证聚合为 Sankey 能量流全景，离线渲染自包含 HTML（见 [symbiosis-sankey-demo.html](./symbiosis-sankey-demo.html)）

### 自我反思与进化
- 目标引擎：从洞察生成目标并分解子任务
- 质量反思引擎：低于阈值自动重试 / 切换模型，阈值按质量分布自校准
- 元认知层（meta/）：自我建模引擎产出四视图心智报告（策略表现/记忆健康/进化效率/系统稳定），元认知控制器保守调参（每轮一步、观察窗、劣化回滚）
- 策略进化：遗传算法演化决策基因 + 策略进化器（policy/）种群进化、沙盒多种子评估、LCB 门禁、金丝雀热切换、劣化自动回滚
- 长期记忆：任务模式、模型画像、经验教训跨会话沉淀

### 记忆体系与检索增强
- **三层记忆 + 知识蒸馏**：情景 → 语义 / 程序记忆，水位门控蒸馏，稳定 id，证据合并与冲突消解
- **SQLite 持久化**：Node 内置 `node:sqlite` 零依赖，关系化分表（`task_patterns` / `model_profiles` / `decision_feedback` + `distilled_strategies` / `meta`）、WAL、版本化迁移、维护 API（完整性检查 / 热备份 / 碎片回收 / 只读 SQL 通道）；加密启用或宿主不支持时自动回退 JSON 原子写后端（[memory/backend.ts](./src/memory/backend.ts)）
- **混合检索**：FTS5 双分词（trigram 中文子串 + token 级）+ 稀疏词频向量余弦 + 记忆图联想，四路召回（`optimizer.hybridSearch`）
- **记忆图**：共现网络与主题图 JSON 序列化跨重启（[memory/memory-graph.ts](./src/memory/memory-graph.ts)）
- **防幻觉短索引**：注入大模型前长 ID 转 `#1…` 短索引，输出后反解（[memory/alias-map.ts](./src/memory/alias-map.ts)）

### 工程基础设施
- Raft 共识、分布式同步、热更新、AES-256-GCM 加密存储
- 多租户隔离、基准测试引擎、零依赖 WebSocket 实时进度（原生 RFC 6455）、可视化 Dashboard
- 18 个 Tool 注册（+ 缺省关闭的层论共识 Tool），宿主融合层全宿主可观测与安全治理

## 自主循环（Autonomy Loop）

每个心跳执行 11 步编排（[autonomy-loop.ts](./src/autonomy-loop.ts)）：

1. **元认知观察** —— 采集 KPI，发现异常洞察
2. **1.5 共生心跳** —— KPI 注入能量经济 + 信念市场
3. **世界模型预见** —— 预测信号到达，捕捉上升趋势；2.5 段容量规划（25.0）反解最小并发，2.7 段尾部风险评估（28.0）POT/GPD 外推 p99.9，2.8 段系统性风险评估（33.0）失败相关矩阵经 Marchenko–Pastur 清洗侦测共同因子暴露
4. **汇总反思教训** —— 合并反思引擎经验教训，去重已消化项
5. **目标生成** —— 从洞察自动生成改进目标并分解子任务
6. **子任务派发** —— 经安全治理审查后注入执行
7. **好奇心探索** —— 剩余预算用于知识盲区探索
8. **策略进化** —— 遗传算法演化决策策略
9. **7.5 策略进化器** —— 调度策略经沙盒验证后金丝雀热切换
10. **7.7 元认知环** —— 自我建模 → 保守调整 → 观察 / 回滚（低频）
11. **8. 记忆维护** —— 经验蒸馏 + 遗忘曲线（低频后台）

## 越用越聪明的三个通路（缺一即退化为静态系统）

1. **经验驱动选型**：优化器推荐的模型组合按节点类型真正参与节点分配（`Optimizer.lookupExperience → ModelScheduler.assignModel`），而非仅作提示词
2. **策略反馈校准**：蒸馏策略按执行结果回写应用成功率，有效策略越用越强、无效策略自然淘汰
3. **经验快路径**：命中高置信度模式（默认 ≥ 0.9，`memoryFastPathThreshold` 可调）时直接召回历史最优成功计划（`Optimizer.recallPlan`），跳过 LLM 重新规划——越用越快、越稳、越省 token

三个对冲机制（防止「越学越错」的安全阀）：

1. **遗忘曲线**：长期未用的记忆按艾宾浩斯模型降置信直至遗忘，`lastDecayAt` 基准幂等衰减
2. **置信度衰减**：成功加分、失败扣分，长期未验证的策略衰减清除
3. **阈值自校准**：质量分布偏高收紧阈值、偏低放宽，避免无效重试风暴

## 安装

要求：Node.js `^22.18.0 || >=24.11.0`。

推荐用 dsh CLI 一键安装（`--profile` 指定目标 profile，如 `web`；构建产物 `dist/` 已随仓库分发，安装零构建脚本）：

```bash
dsh plugin add beijingwahw/dsh-proactive --profile web
dsh web
```

## 开发期热更新（HMR）

| 层 | 方法 | 生效范围 |
|---|---|---|
| 运行配置 | 编辑 dsh 用户层 `cordis.patch.yml`（`~/.dsh/profiles/<name>/` 或 `~/.dsh/`），保存即生效 | dsh 原生监视用户层，事务性重载该行（bundle 层默认值已全量列出，照抄整行覆盖即可） |
| 开发期代码 | `npm run dev` 起独立 cordis + HMR 进程 | 保存 `src/` 下任意文件或 `cordis.yml` → 旧实例卸载（调度器资源清理回卷）→ 新代码挂载，无需重启 |
| 安装产物 | 改代码 → `npm run build` → 重新 `dsh plugin add` → 重启 dsh | 更新已安装的插件 |

`npm run dev` 的组成：仓库根 `cordis.yml` 依次挂 logger / timer / hmr / 宿主桩 / 本插件（直接加载 `src/index.ts`，config 与 `cordis.patch.yml` 逐键一致，开发行为 = 生产 bundle 行为）；
`dev/host-stubs.ts` 提供宿主 `tools` 服务桩，让全部 Tool 走完整桥接链路（宿主无该服务时插件会静默降级，桩让开发进程更接近 dsh 运行时形态）。

## 配置（零手动配置）

**开箱即用，无需手动配置任何模型或密钥，插件本身也不持有任何 API Key。**

- 随附的 [cordis.patch.yml](./cordis.patch.yml) 已封装全部国产模型（DeepSeek / 通义千问 / 智谱 / Kimi / MiniMax / 讯飞星火 / 腾讯混元 / 百度文心 / 商汤日日新），加载即用；
- 运行时插件经 ctx 上下文获取 DSH 已配置好的 LLM 客户端，DSH 自动把用户配置的 Key（Web UI 填写或环境变量配置）注入请求头；
- **密钥自动填入**：插件还会自动读取宿主本地密钥并按厂商匹配填入请求头，优先级为 宿主 ctx 注入 → 进程环境变量（如 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`，按模型 id 前缀匹配厂商）→ DSH 本地配置文件（`~/.dsh/config.json` 等，mtime 热更新、缺失时定期重探测）；密钥只进内存，不落盘、不打印；
- **多密钥故障转移**：同一厂商存在多个候选密钥时，认证失败（401/403）或配额耗尽（429）会自动轮换到下一个候选密钥重试，并升级为**健康感知路由**——按成功/失败统计选择最优密钥，429 冷却 1 分钟、401/403 冷却 5 分钟，成功后自动恢复；用户可通过 `manage_keys` 工具调整密钥使用顺序（持久化，重启保留），启动日志输出每个模型的密钥来源（不含密钥值），运行时可用 `query_memory keys` 查看各密钥健康状态；
- 若只需单一厂商，可改用 `patches/domestic-models/` 下按厂商拆分的 patch；重新生成：`pnpm generate:patches`。

完整运行配置项（哨兵 / 加密 / 同步 / 共识 / 热更新 / 租户 / 自主循环 `autonomy` / 宿主融合 `hostFusion`）同样内置于 [cordis.patch.yml](./cordis.patch.yml)，无需改动；共生经济子项位于 `autonomy.symbiosis`（futarchy 表决、能量反哺等，缺省关闭）。保证层内核 12.0-16.0、几何/拓扑层内核 17.0-20.0 与最优调度层内核 21.0-22.0 子项同样缺省关闭（零漂移）：`autonomy.anytimeEvidence`（α / 水位线）、`autonomy.conformal`（α / 校准容量 / 阈值风险与置信）、`autonomy.qualityDiversity`（探索率）、`autonomy.runtimeVerification`（附加规约 `specs`）、`autonomy.optimalTransport`（监测 KPI / 窗口 / 阈值分位）、`autonomy.informationGeometry`（KL 信任域 / 步长尺度）、`autonomy.optimalStopping`（机会视野 / 最小样本）、`autonomy.sheafConsensus`（障碍失配容差）、`autonomy.indexScheduling`（贴现 / 网格）、`autonomy.banditKnapsack`（UCB α / 可行性松弛 / 视界）、`autonomy.robustStatistics`（α）、`autonomy.privacy`（ε / δ）、`autonomy.capacityPlanning`（目标等待 / SCV）；先知层 26.0-30.0 子项同样缺省关闭（零漂移）：`autonomy.gaussianProcess`（校准点数 / 最小点数）、`autonomy.kalmanFilter`（过程噪声 / 观测噪声 / 门控分位）、`autonomy.extremeValue`（p99 目标 / 最小样本 / 阈值分位）、`autonomy.mcts`（迭代 / 探索常数 / 折扣）、`autonomy.submodular`（主题覆盖强度）；均衡层 31.0-35.0 子项同样缺省关闭（零漂移）：`autonomy.hedgePortfolio`（学习率 η / 回灌率 α）、`autonomy.optimalAssignment`（候选池上限）、`autonomy.randomMatrix`（窗口 / 最少模型 / 边界倍数 / 份额门槛）、`autonomy.cvarTimeouts`（置信水平 α / 裕度 / 样本下限）、`autonomy.concurrencyControl`（目标利用率 / 被控增益 / 控制权重 / 死区）；觉醒层 37.0-40.0 子项同样缺省关闭（零漂移）：`autonomy.informationBottleneck`（β / 保留率下限）、`autonomy.chaosDiagnostics`（最少点数 / λ 阈值 / Hurst 半宽）、`autonomy.spectralRanking`（阻尼）、`autonomy.firstPassageCooldown`（恢复置信目标）；川流层 41.0-45.0 子项同样缺省关闭（零漂移）：`autonomy.queueingNetwork`（瓶颈 ρ 阈值）、`autonomy.spectralCalendar`（小时分桶数）、`autonomy.capacityFrontier`、`autonomy.fairBudget`、`autonomy.ocbaAllocator`（确认预算）；经纬层 49.0-50.0 子项同样缺省关闭（零漂移）：`autonomy.waveletView`（最少点数）、`autonomy.latentFactors`（潜维数）；经纬层 46.0-48.0 为引擎只读方法（Raft `quorumAudit` / Sync CRDT 通道 / CryptoEngine `shardKey`），无运行时开关；36.0 持续同调经 `query_memory` 的 `topology` 动作按需查询（零漂移）。

## 工具一览（18 个 + 缺省关闭的层论共识 Tool）

| 分组 | 工具 |
|------|------|
| 执行与调度 | `autonomous_execute` · `model_dashboard` · `run_benchmark` |
| 记忆与知识 | `query_memory` · `query_experience` · `distill_knowledge` · `maintain_memory` · `memory_migration` |
| 元认知 | `mental_report` · `self_knowledge` · `meta_cognition` |
| 自主治理 | `manage_autonomy` · `manage_keys` |
| 基础设施 | `manage_tenants` · `manage_encryption` · `manage_sync` · `manage_consensus` · `manage_hot_reload` |
| 层论共识（缺省关闭） | `sheaf_consensus`（20.0：多源信念结构化融合 + 结构性分歧检测，`autonomy.sheafConsensus.enabled` 启用） |

通过 `manage_autonomy` 获取七维自省报告：

```jsonc
// 调用：manage_autonomy { "action": "introspect" }
// 返回（示例，字段节选）：
{
  "loop":      { "running": true, "tickCount": 42 },
  "health":    { "score": 0.86 },
  "goals":     { "active": 3 },
  "exploration": { "totalExplorations": 5 },
  "governance":  { "circuitState": "closed" },
  "worldModel":  { "types": 4 },
  "evolution":   { "generation": 7 }
}
```

其他常用操作：

- `manage_autonomy`：`start` / `stop` / `tick` / `kill-switch` / `revive` / `reset-circuit`
- `query_memory`：`world-model` / `curiosity` / `governance` / `patterns` / `lessons` / `keys` 等

## 离线验证（43 个，零 API Key）

每个内核与子系统均有离线端到端验证脚本（`node scripts/verify-*.mjs`）：

```bash
node scripts/verify-scientist.mjs     # 科学家：EIG 定价 / 预算仲裁 / 知识前沿收缩
node scripts/verify-theorist.mjs      # 理论家：定律归纳 / 零样本预测 / 范式转移
node scripts/verify-symbiosis.mjs     # 共生经济：账本 / 市场 / 三智能体六轮心跳闭环
node scripts/verify-self-evolution.mjs # 自进化闭环：推荐采纳 / 快路径 / 三对冲机制
node scripts/verify-anytime-evidence.mjs # 任意时刻证据：CS 时间一致性 / e-过程裁决 / e-BH FDR
node scripts/verify-shapley.mjs       # Shapley：四公理 / 置信区间 / 协同侦测
node scripts/verify-frontier-kernels.mjs # 几何与拓扑层 17.0→20.0：解析解对照 / 坐标不变性 / 先知 2-3 / 层障碍检测
node scripts/verify-frontier-wiring.mjs # 几何与拓扑层接线：真实引擎端到端（漂移洞察 / 自然变异 / 数学 defer）
node scripts/verify-prophet-kernels.mjs # 先知层 26.0→30.0：GP 插值/EI-MC 对照 / Riccati 闭式 / POT 解析分位 / UCT 收敛 / CELF-穷举对照
node scripts/verify-prophet-wiring.mjs  # 先知层接线：真实引擎端到端（GP 校准 / NIS 门控洞察 / 延迟样本→尾部外推 / UCT 互查 / 互补盲区入选）
node scripts/verify-equilibrium-kernels.mjs # 均衡层 31.0→35.0：对抗遗憾界 / 匈牙利-穷举对照+对偶证书 / MP 边界贴边 / CVaR-RU 对账 / DARE 闭式 / Lyapunov 机器精度
node scripts/verify-equilibrium-wiring.mjs  # 均衡层接线：真实引擎端到端（对抗降权翻盘 / 批内一对一 / 共同因子洞察 / 重尾超时定价 / 并发闭环）
node scripts/verify-awakening-kernels.mjs  # 觉醒层 36.0→40.0：大陆孤岛+瓶颈稳定性 / IB-DPI+β 前沿 / logistic λ₁=ln2+Hurst 体质 / 环图精确均匀 / 反射原理 2 万路径对照
node scripts/verify-awakening-wiring.mjs   # 觉醒层接线：真实引擎端到端（知识地形 / 蒸馏信息拦截 / 混沌体质翻转洞察 / 枢纽影响力 / 熔断冷却定价）
node scripts/verify-flux-kernels.mjs     # 川流层 41.0→45.0：串联 M/M/1 模拟对照 + Jackson 独立性 / FFT 恒等 + Parseval + 周期恢复 / 最大流-穷举对照 + 割证书 / 教科书注水 + 公平审计 / OCBA-均匀 P(CS) 对照
node scripts/verify-flux-wiring.mjs      # 川流层接线：真实引擎端到端（谱日历昼夜判定 / 容量前沿回写 / 家族公平反饿死 / OCBA 瓶颈聚焦）
node scripts/verify-fabric-kernels.mjs   # 经纬层 46.0→50.0：quorum 闭式-穷举对照 + 3f+1 下界 / CRDT 置换收敛 + add-win / Shamir 阈值重建 + 零泄露 / 小波完美重构 + Parseval / 低秩恢复
node scripts/verify-fabric-wiring.mjs    # 经纬层接线：真实引擎端到端（Raft 安全审计 / 双实例 CRDT 收敛 / 密钥分形重建 / 小波突发捕获 / 冷启动潜因子外推）
```

| 分组 | 脚本 |
|------|------|
| 双心智 | verify-scientist · verify-theorist |
| 质变内核 | verify-unified-evidence · verify-resilience-governance · verify-causal-kernel · verify-active-inference · verify-deliberation · verify-metareasoning · verify-abstraction |
| 保证层内核 12.0-16.0 | verify-anytime-evidence · verify-conformal · verify-quality-diversity · verify-runtime-verification · verify-shapley |
| 几何与拓扑层 17.0-20.0 | verify-frontier-kernels · verify-frontier-wiring |
| 创世层 21.0-25.0 | verify-genesis-kernels · verify-genesis-wiring |
| 先知层 26.0-30.0 | verify-prophet-kernels · verify-prophet-wiring |
| 均衡层 31.0-35.0 | verify-equilibrium-kernels · verify-equilibrium-wiring |
| 觉醒层 36.0-40.0 | verify-awakening-kernels · verify-awakening-wiring |
| 川流层 41.0-45.0 | verify-flux-kernels · verify-flux-wiring |
| 经纬层 46.0-50.0 | verify-fabric-kernels · verify-fabric-wiring |
| 共生经济 | verify-symbiosis · verify-symbiosis-bridge · verify-belief-market · verify-futarchy · verify-energy-feedback · verify-full-agents · verify-observability |
| 学习与进化 | verify-self-evolution · verify-self-evolution-v2 · verify-knowledge-distillation · verify-policy-evolution · verify-meta-cognition · verify-meta-cognition-v2 · verify-meta-edge · verify-consensus-sync |

能量流向可视化：浏览器打开 [symbiosis-sankey-demo.html](./symbiosis-sankey-demo.html)（零依赖自包含页面）。

## DSH 插件规范符合性

本插件遵循 DeepSeek Harness（cordis）插件开发规范，在不影响性能的前提下完成以下规范化提升：

- **函数插件形态 + 静态元数据**：默认导出为 `apply(ctx, config)` 函数插件，并挂载 `name` / `Config` / `provide` 静态元数据，供注册表与加载器识别；
- **Schemastery Config schema**：`Config` 为标准 schema，加载时由 cordis `resolveConfig` 自动校验类型并填充默认值（哨兵 / 加密 / 同步 / 共识 / 热更新 / 租户 / 自主智能等全部配置节）；函数型注入字段（`nodeRunner` / `judge` / `llm.fetchImpl` 等）与共生嵌套配置作为额外属性透传，不受校验影响；
- **官方 Tool 注册链路**：宿主加载 `@deepseek-ai/dsh-tools`（`ctx.tools` 服务）时，全部 Tool 经 duck-typing 桥接注册进官方 ToolRegistry，纳入 pre/around/post 执行管线与模型可见面（参数转为官方 JSON Schema 子集）；宿主未提供时静默降级为内部 ToolRegistry + `ctx.provide('schedulerTools')`，不引入整套 agent 栈依赖；
- **依赖注入与服务声明**：经 `ctx.provide('scheduler' / 'schedulerTools')` 暴露服务面，并通过 TypeScript 声明合并（`declare module '@deepseek-ai/cordis'`）为 `Context` 注入类型；
- **生命周期清理**：全部资源在 fiber 卸载时经 `ctx.effect` 按依赖逆序清理（含官方 Tool 注销）；
- **发布清单**：`package.json` 声明 `dsh.bundle.patch` 指向 [cordis.patch.yml](./cordis.patch.yml) bundle 配置层，`exports` / `files` / `engines` / `keywords` 齐备，dist/ 构建产物随仓库分发（安装零构建脚本，规避 pnpm allowBuilds 拦截）。

## 宿主融合层（Host Fusion）

在规范化之上，插件经 cordis 跨 fiber 事件机制深度融入宿主运行时，从"被动插件"升维为**宿主级认知与安全层**（宿主加载 `@deepseek-ai/dsh-tools` 时自动激活，否则静默降级）：

- **全宿主可观测**（`tools/result`，emit）：观测宿主全部工具调用结果——每次调用经世界模型 `observeArrival` 学习宿主行为节律（增强预见性）；工具失败注入 `host-tool-failure` 信号至哨兵，触发决策链路自愈；同工具连续失败达阈值（默认 3 次）自动升级：高紧急度信号 + 教训沉淀至反思引擎；
- **全宿主安全治理**（`tools/pre-execute`，waterfall）：调度器的安全治理器获得对宿主管线的否决权——Kill Switch 启用时冻结全宿主工具调用（紧急停止从"冻结自身"升级为"冻结宿主"）；调度器自身失败螺旋触发熔断器时 fail-closed 拒绝宿主动作；只读门控（`checkGate`），不消耗限流/预算；
- **安全设计**：观测 fail-open（自身异常绝不破坏宿主管线）、治理 fail-closed（仅显式安全状态拒绝）；自排除调度器自身 18 个桥接 Tool，避免反馈环路；零新增依赖（结构化类型 + 声明合并）。

配置节 `hostFusion`：`enabled` / `observeToolResults` / `governToolCalls` / `failureEscalationThreshold`（默认 `true / true / true / 3`）。

## 项目结构

```
├── cordis.patch.yml              # bundle 配置层（dsh.bundle.patch 指向，全部国产模型零密钥）
├── symbiosis-sankey-demo.html    # 认知生态能量流 Sankey 全景（零依赖自包含）
├── patches/domestic-models/      # 按厂商拆分的可选 patch（9 厂商 + all-domestic.yml）
├── scripts/                      # patch 生成器 + 43 个离线验证脚本
└── src/
    ├── index.ts                  # 插件入口：10 步主链路编排 + Tool 注册
    ├── types.ts / errors.ts      # 共享类型层 / 统一错误体系（稳定机器可读 code）
    ├── contracts.ts              # 三支柱接口契约（IMemoryStore / IReflector / IOptimizer）
    ├── llm-client.ts             # LLM 统一调用：超时 / 指数退避 / 并发信号量 / 成本统计
    ├── progress-ws.ts            # 零依赖 WebSocket 进度广播（原生 RFC 6455）
    ├── sentinel.ts               # 信号感知：多源接入 + 聚合窗口
    ├── decision-engine.ts        # 战略决策：四级决策 + 统计学习校准
    ├── model-scheduler.ts        # 模型调度：能力画像 × 记忆加权 × 成本感知 × 能量反哺
    ├── task-executor.ts          # 任务执行：DAG 并行 + 质量反思重试 + 级联触发
    ├── optimizer.ts              # 优化器：经验检索 + 混合检索 + 快路径计划召回
    ├── reflector.ts              # 反思器：复盘 + 记忆更新 + 策略反馈 + 蒸馏
    ├── reflection-engine.ts      # 质量反思引擎：阈值自校准 / 教训提取
    ├── goal-engine.ts            # 目标引擎：洞察 → 目标 → 子任务
    ├── world-model.ts            # 世界模型：到达预测 / 趋势检测 / 校准（MAE）
    ├── curiosity-engine.ts       # 好奇心引擎：知识盲区扫描 / 自适应探索预算
    ├── safety-governor.ts        # 安全治理：限流 / 预算 / 熔断 / 置信度门控 / Kill Switch
    ├── meta-cognition.ts         # 元认知监测
    ├── strategy-evolution.ts     # 策略进化：遗传算法演化决策基因
    ├── autonomy-loop.ts          # 自主循环：11 步心跳编排
    ├── host-fusion.ts            # 宿主融合层：全宿主可观测 + 安全治理
    ├── dsh-host.ts               # DSH 宿主集成：LLM 客户端 / 模型目录 / Key 注入
    ├── core/                     # 质变内核：evidence 3.0 → matrix-completion 50.0 四十八内核
    ├── meta/                     # 元认知层：自我建模 + 元认知控制器（双环外环）
    ├── policy/                   # 策略进化器 + 安全沙盒：种群进化 / 金丝雀部署
    ├── symbiosis/                # 认知能量共生经济：账本 / 市场 / 信念市场 / 智能体 / 运行时 / Sankey
    ├── memory/                   # 长期记忆：SQLite/JSON 双后端 + 记忆图 + 别名映射 + 迁移
    ├── consensus/                # Raft 共识
    ├── sync/                     # 分布式同步
    ├── hot-reload/               # 热更新
    ├── security/                 # 加密引擎（AES-256-GCM）
    ├── tenant/                   # 多租户
    ├── benchmark/                # 基准测试
    └── dashboard/                # 可视化面板
```

## 许可

[MIT](./LICENSE)
