# 第五轮升级公告（Kernel Evolution）：全部内核世界性进化

**版本 1.0.0**（自 0.9.0 升级）。主题：**「全部内核世界性进化」**——模块层两轮铺满（第三轮全部模块升级、第四轮激活接线）之后，第五轮回到**内核层本体**：九十八个质变内核（3.0 → 100.0）每一个都沿**四条进化轴**再进一格。不是加内核，是让既有内核「算得更对、算得更快、病态下不坏、性质上可证」——版本直达 **1.0.0**（百内核全进化里程碑）。

## 升级概览

- **升级面**：98 内核 × 四轴进化，按数学亲缘分 **18 组**收口（统计推断 / 因果科学 / 贝叶斯计算 / 元认知 / 信息几何 / 规划搜索 / 决策计算 / 在线学习 / 控制优化 / 随机过程 / 谱方法 / 拓扑动力 / 公平分配 / 共识验证 / 进化学习 / 博弈机制 / 学习系统 / 弹性自主），每组 3-6 内核
- **四轴口径**（每内核 ≥ 2 轴、≥ 1 轴来自数学或性能轴）：
  - **轴 1 数学进化**——新定理背书的能力：闭式解（贝叶斯因子 / 泊松最优停止 / Fisher 双曲距离 / 漂移首达）、精确算法（GES 动态规划 / Whittle 策略迭代 / 图割 SFMin）、更紧的界（k 选择先知不等式 / CVaR 样本复杂度 / w-次优界）
  - **轴 2 性能进化**——复杂度改进 + **等价证明**：新实现与旧口径逐位或解析容差一致（脚本内复刻参考实现对照），另附规模-耗时对照；核仁 13937ms → 1ms、组合拍卖分支定界 ×6141、k-of-n 闭式 1867×、Gittins 播种二分 32.5×
  - **轴 3 数值稳健性**——病态输入加固与 log 域重写：log 域 WIS（朴素口径直接下溢 throw）、Lanczos logGamma/logBeta、万步 e-过程资本、Fisher g 大 m、Joseph 形式 2000 步严格对称、Cholesky 抖动回退
  - **轴 4 随机化性质测试**——每内核 ≥ 200 种子化输入检验数学性质（无偏性 / 覆盖频率 / 单调性 / 守恒律 / 度量公理 / 凸性 / 公理满足），mulberry32 种子固定、同输入同输出
- **导出收口（R5-A19）**：80 个新内核 API 收口至根入口 `dist/index.mjs`——集成脚本对全部 80 符号逐一做运行时可达性断言（`typeof` 按值种类分桶校验）
- **验证**：新增 18 个组级 `verify-r5-*` + 1 个集成回归 `verify-r5-integration`，合计 **1,471 项断言**（18 组 1,441 + 集成 30）；离线验证脚本总数 **119 → 138**，全量复验 **138/138 全绿**
- **确定性纪律**：全套件延续 `node --experimental-transform-types` 统一口径；随机处一律种子化（内核/脚本自带 mulberry32），耗时断言只取方向性且大实例化以抗负载抖动

## 18 组进化矩阵

| 组 | 内核（编号） | 数学进化（轴 1 代表） | 性能 / 数值数字（轴 2/3 代表） | 性质测试（轴 4 代表） |
|----|--------------|------------------------|--------------------------------|------------------------|
| R5-A1 统计推断 | evidence 3.0 · anytime-evidence 12.0 · conformal 13.0 · robust-statistics 23.0 · differential-privacy 24.0 | 贝叶斯因子闭式 + Kass–Raftery 分级；混合 e-过程凸组合 + 对偶置信集 AV-CI；Mondrian 组条件保形；Hodges–Lehmann 估计（ARE 3/π、崩溃点 1−1/√2）；指数机制 + 高斯 RDP 闭式最优阶转换 | 保形阈值选择 O(2Gn) → O(n log n + G log n)（解析等价）；quickselect 中位数 O(n) 与排序逐位等价；Lanczos log 域 logGamma/logBeta；万步 e-过程 log 域资本（线性域下溢） | 混合 e-过程功效 2.7×；Mondrian 失衡组覆盖 18.8% → 93.0%；RDP 最优阶 200/200 更省；DP 守恒 / 单调 / 分布（≥200 种子） |
| R5-A2 因果科学 | causal-kernel 5.0 · scientist 10.0 · theorist 11.0 · causal-discovery 77.0 | 自然直接/间接效应 NDE/NIE（前门调整）；GES 精确动态规划（d ≤ 12 全局最优）；批次 EIG 次模贪心；MDL 两部码分解 | 批 EIG 贪心逼近 oracle；两部码账目守恒 | total = NDE + NIE 恒等（部分中介）；可识别门槛诚实（无干预证据 → false）；线性 SEM 等价类恢复 |
| R5-A3 贝叶斯计算 | free-energy 6.0 · gaussian-process 26.0 · kalman-filter 27.0 · variational-inference 57.0 · langevin-sampling 58.0 | EFE 规范分解（risk = KL ≥ 0、pragmatic = risk + H₂、认知项随证据 → 0）；自然梯度；欠阻尼 MALA；FITC 稀疏 GP（m = n 退化精确）；UKF ≡ KF（线性精确性定理）+ Joseph 形式 | 自然梯度 12 步 vs 普通梯度 2000 步；ELBO 早停 16 vs 800 迭代；标量 Kalman 特化 ≈ 2.6×；梯度/能量复用求值 = 步数 + 1；betaEntropySiblings 求值减半 | ESS 424 vs 116（缓方向）；蛙跳可逆性 300 点 1e-10；细致平衡分箱转移计数对称（偏差 ≤ 4σ）；CAVI 收敛解析后验（200 种子） |
| R5-A4 元认知 | deliberation 7.0 · metareasoning 8.0 · abstraction 9.0 · global-workspace 96.0 · metacognitive-confidence 97.0 | 贝叶斯说服模型（L_R 逐轮恒等、B_R 手算锚）；泊松最优停止闭式；率失真最优抽象粒度；GWT 温度退火；二阶 ROC 参数拟合（meta-d′ MLE） | 说服强度包络单调；退火后胜者分布熵随温度可控 | 种子化性质输入 2,292 个（脚本实测注记）；M-ratio 分离与求助阈值闭式 |
| R5-A5 信息几何 | optimal-transport 17.0 · information-geometry 18.0 · information-bottleneck 37.0 · compression-distance 68.0 · partial-info-decomposition 70.0 | 精确 1D W_p（CDF 合并、去网格化）；Sinkhorn 散度 + Feydy 去偏；Fisher 双曲距离闭式；确定性 IB；BROJA 一阶 KKT 残差证书；LZ77 压缩器 | NCD 分辨率 38–44×（LZW 自距离 0.41 → LZ77 ~0.0x）；热启动等价与迭代收益；线搜索早停等价 + 求值节省 | 去偏 S(μ,μ)=0、ε→0 收敛 W₁；W₁ 度量公理（250 种子）；IB 曲线凹性 + β 单调 + DPI（200 种子）；PID 守恒/可行性（220 种子） |
| R5-A6 规划搜索 | optimal-stopping 19.0 · mcts 29.0 · astar-search 71.0 · pomdp-planning 84.0 · symbolic-solver 85.0 | k 选择先知不等式（online ≥ k/(k+1)·prophet）；PUCT；加权 A* w-次优界；VSIDS + 两观察文字；PBVI | 子树重用（同根续算 201 visits vs 独立重跑 101）；惰性 h 调用 ≈ 39%｜V｜ | 随机化阈值规则 100% 成界；Ĉ ≤ w·C* 全种子；包络链 rule ≤ online ≤ prophet；引擎等价（counted vs scan 逐位一致） |
| R5-A7 决策计算 | index-scheduling 21.0 · bandit-knapsack 22.0 · speculative-decoding 51.0 · test-time-compute 52.0 · whittle-index 53.0 · best-arm-identification 73.0 | 成本版 Gittins（边界态闭式 ν^c = p̂ − c）；BwK LP 对偶证书；Whittle 策略迭代精确解；LUCB 追踪；加权多数 DP 精确；树投机束式闭式 | Gittins 播种二分 32.5×（vs 旧全域二分，26 轮圆整口径全网格对照）；Whittle 精确 7× | 对偶证书 8.4× 单调链；ν^c 关于 c 单调不增（≥200 种子 × 成本格点）；KKT/互补松弛可逐位检查 |
| R5-A8 在线学习 | online-learning 31.0 · dynamic-pricing 65.0 · mirror-descent 74.0 · online-calibration 75.0 · off-policy-evaluation 88.0 · safe-policy-improvement 89.0 | AdaHedge（对数体制，regret ≤ 2.5√(T lnN) + 势函数证书）；乐观 FTRL（常数流 O(1)）；在线覆盖追踪；稀缺性定价 DP 短路定理；switch-DR；多候选 FWER（δ/k 精确） | 常数流乐观 regret ≤ 经典 OMD 的 1/5；投影快速路径 2×10⁴ 向量 1e-12；StreamingOPE 单遍 ≡ 批四口径；LazyHedge exp 消除 ≥ 2× | 稀缺收益中位 1.23× 无视库存 UCB、售罄延后（783 vs 618）；switch-DR 方差 ×10.6 降；k=8 真退步 FWER ≤ δ + 容差（500 种子）；对数域 WIS（朴素下溢 throw） |
| R5-A9 控制优化 | optimal-assignment 32.0 · robust-decisions 34.0 · feedback-control 35.0 · max-flow 43.0 · lyapunov-drift 54.0 · safety-barrier 87.0 | CVaR 场景逼近有限样本界（McDiarmid）；LQG 分离定理；多队列加权利亚普诺夫（持有成本权重进背压）；多屏障合取；稀疏 LSAP 结构性禁边 + Hall 检查；最小费用流 SSP + 无负环最优性证书 | CVaR 样本省 49×；cvarProfile 一次排序多档 α；一般-a DARE 精确闭式 + LPV 热启动；稀疏 JV vs 稠密填充；Dinic vs Edmonds-Karp 耗时对照 | heavy-traffic 加权背压打赢 LQF；200 种子闭环双屏障 0 违反；300 随机实例完美匹配 ≡ 稠密最优；随机图 ≥ 50 流守恒残差审计 |
| R5-A10 随机过程 | capacity-planning 25.0 · extreme-value 28.0 · first-passage 40.0 · queueing-network 41.0 · spectral-periodicity 42.0 · hawkes-process 55.0 | M/G/1 Pollaczek–Khinchine（C_s²=1 → M/M/1 精确、C_s²=0 → 恰半）+ Kleinrock 守恒律 + cμ 穷举最优；多类别平方根 staffing；多维 Hawkes（谱半径 + (I−A)⁻¹μ）；谐波梳 + Fisher g 精确 Beta p；GPD 返回水平 delta-CI；漂移首达闭式（μ<0 → e^{2μa/σ²}） | Kingman 初值局部搜索 vs 旧二分（200 题逐位同解）；fitGpd 矩初始化；fftAutocorrelation（Wiener–Khinchin）逐位等价 | Hawkes 矩阵恢复 ±0.017；守恒律 K! 排列不变；Little 定律逐类守恒；Fisher g 大 m log 域（旧式 NaN 区有限）；drift log 域 μa/σ²=5000 不溢出 |
| R5-A11 谱方法 | random-matrix 33.0 · spectral-ranking 39.0 · multiscale-wavelet 49.0 · matrix-completion 50.0 · canonical-correlation 78.0 · diffusion-maps 79.0 | 个性化 PageRank（重启随机游走，修悬挂节点双重计数）；MP 解析密度（质量 = 1）+ Tracy–Widom 分位数/矩（Painlevé II 数值解）+ Johnstone 边缘标准化；Gavish–Donoho 最优硬阈值；Daubechies D4 代数解系数；核 CCA；地标扩散 | 稀疏列幂迭代大图耗时对照；Jacobi 镜像旋转等价 + 计时；地标扩散 69×；原地化逐位等价（128K 计时） | 秩恢复 100%（keep = 真秩、NMSE ≪ keep-all）；非线性依赖 0.806 vs 0.215（RBF ρ vs 线性 ρ）；三团分类 100%；D4 完美重构 + Parseval（200 种子） |
| R5-A12 拓扑动力 | persistent-homology 36.0 · nonlinear-dynamics 38.0 · simulated-annealing 66.0 · mapper-graph 69.0 · novelty-detection 76.0 · novelty-search 91.0 | H₁ 代表圈 + clearing 引擎；Euler–Poincaré（χ = β₀−β₁+β₂）；Mapper 分位数覆盖（无重无漏、纤维 max/min ≤ 2 vs 等宽 > 5 倍失衡）；Wolf Lyapunov；LOF + Tukey 半空间深度；并行回火 + Luby 重启 | clearing 消元次数 ≤ 朴素全矩阵；singleLinkageFast 逐位一致（n = 2000 计时）；密度档案精简（同样预算铺得更开） | Wolf λ₁ ≈ ln2 精确（logistic r=4）、周期窗 ≈ 0、吸引子塌缩诚实 undefined；瓶颈距离度量公理（200 种子）；LOF 注入 200 种子 ≥ 95% 分离；并行回火 40/40 ≥ 单链 |
| R5-A13 公平分配 | shapley 16.0 · fair-division 44.0 · budget-allocation 45.0 · rate-distortion 60.0 · nucleolus 63.0 · attention-economy 99.0 | 加权 Shapley（Kalai–Samet 非对称权、部分排列 DFS，λ=3:1 → φ=1/4:3/4 手算锚）；分层排列采样 + Bonferroni CI；EF1 判定 + 嫉妒循环消除（定理保证）；序保持 OCBA 圆整；加权汉明 RD；衰减注意力 | nucleolusFast 13937ms → 1ms（对称类归并 + 批量等价加速） | 效率/虚拟/可加公理 ≥ 50 例；等权精确退化；CI 真值覆盖；无阻挡对证书随结果返回 |
| R5-A14 共识验证 | runtime-verification 15.0 · sheaf-consensus 20.0 · quorum-systems 46.0 · crdt 47.0 · secret-sharing 48.0 · belief-propagation 56.0 | R+W>n 读写一致性分析器（overlap = R+W−n 闭式）+ 栅格法定人数；delta-CRDT；Feldman VSS；LTLf 过去算子 + DFA 最小化；层论 H⁰ 维数 + 全局截面；Bethe 自由能（树上 = −ln Z）+ GDL 前缀积 | delta-CRDT 通信 −44%；在线监视 ×17431；GDL 前缀积 ×31.6 | 120 组随机读写序列——R+W>n 零陈旧读、R+W≤n 陈旧读真实出现（下界两侧实证）；VSS 篡改 100% 拒；树上 Bethe = −ln Z 精确 |
| R5-A15 进化学习 | quality-diversity 14.0 · curriculum-learning 59.0 · nsga2-pareto 67.0 · self-play 92.0 · automl-hyperband 93.0 · experience-replay 98.0 | CVT-MAP-Elites（确定性 Lloyd）；ε-支配归档；弱点画像 + α-rank；最优课程排序定理；三因子重放；η 扫描理论 + 异步 bracket | CVT 覆盖 = 1 > 网格口径（网格被均匀格线卡死）；ε-支配归档规模受控 | 量化误差单调不增（200 种子）；Voronoi niche 等量份额（200 种子 × 10000 点，4.5σ 界）；课程排序定理背书 |
| R5-A16 博弈机制 | stable-matching 61.0 · mechanism-design 62.0 · correlated-equilibrium 64.0 · argumentation 81.0 · crowd-aggregation 82.0 · preference-learning 90.0 | 多对一容量 DA（Roth–Sotomayor 响应式偏好，Rural Hospital 定理）；组合拍卖分支定界；粗糙 CE 检查器（Nash ⊆ CE ⊆ CCE 三层包含）；已知混淆贝叶斯聚合；价值型论证 VAF；Plackett–Luce（≡ Bradley–Terry、IIA 公理） | 组合拍卖分支定界 ×6141（vs 2^m 全子集，同最优值同 argmax）；队列化 DA 逐位同 + 耗时；learnCEFast 与 learnCE 逐位相同；EM 对数表（极端混淆 0.999 不 NaN）；独立集 DFS 位掩码化 | 容量 1 退化 ≡ 一对一 DA（100 种子）；全对抗 crowd 贝叶斯聚合 = 1.0（多数票塌方）；200 随机 VAF × 全受众 vs 暴力逐受众一致；DSIC/IR 谎报抽样 800 剖面 |
| R5-A17 学习系统 | submodular 30.0 · sparse-recovery 72.0 · streaming-sketch 80.0 · world-model-learning 83.0 · options-framework 86.0 · simulation-calibration 94.0 | 图割 SFMin（s-t 最小割能量最小化，全局最优）；SAFE 强规则筛选；优先扫除（prioritized sweeping）；瓶颈技能自动发现（Brandes 介数 + Tarjan 关节点 → 选项自动生成）；CountSketch（负计数对消）；截断 IW + 加权 bootstrap | 堆化 CELF = 朴素贪心逐位同解且评估次数 < n·k | SFMin vs 2ⁿ 穷举 260 种子同解（gap ≤ 1e-9）；CutEnergy 次模性 0 违反；SAFE 安全筛选 0 违例；CountSketch 负计数精确对消 |
| R5-A18 弹性自主 | resilience 4.0 · interruptible-autonomy 95.0 · self-boundary 100.0 | Weibull 全闭式（k=1/k=2 解析锚、危险率形态）；k-of-n Poisson-binomial 系统可用性闭式；弹性预算（冗余/修复增益 q* = 1/2 交叉点）；多源中断组合不变性（union 触发 + max-penalty 碰撞）；多步因果链 + 他者模型（mirror/counter/independent/environment 四类） | k-of-n 闭式 vs 蒙特卡洛 1867×（8 组件 20 万试验，偏差 < 3σ）；向量化阈值扫描 6.5×；增量偶然性 vs 128 次批量重扫 | 7 个非空中断子集 × 5 种子修正全部收敛同一 Q*（<1e-2）、无修正全部偏置（>0.5）；四类他者模型 120 种子全对（意图方向 ±0.80 级相关）；贪心预算分配 = 组分穷举最优（50 实例） |

**R5-A19 集成回归（收官）**：18 个组级脚本之上的集成层收口，三件事——① 进化内核链 8 组跨组一条龙（76.0 LOF 过滤 → 69.0 分位数覆盖建骨架 → 53.0 退化臂闭式指数 → 21.0 成本 Gittins 边界态 → 63.0 对称博弈核仁 → 99.0 衰减注意力 → 64.0 learnCEFast 等价 → 77.0 gesLite 等价类恢复），**全部经 `dist/index.mjs` 根入口取符号**（新 API 从根入口可达才有资格进链）；② 性能等价抽查 3 路（learnCEFast / nucleolusFast / allocateAttentionFast 大实例等价 + 方向性耗时，best-of-3）；③ **导出面完整断言：80 个新符号逐一从根入口运行时可达**。

## 导出收口：80 个新内核 API

第五轮把 18 组进化产出的 80 个新 API 收口进根导出（`src/index.ts` 显式名单补入 + `dist/index.mjs` 构建产物）：evidence（wilson 上界 / logBeta / 贝叶斯因子）、自由能（蛙跳 / OU 动量刷新尺度）、稳定匹配（容量约束 DA / 队列化 DA / 医院-居民市场）、机制设计（组合拍卖 VCG）、核仁（批量等价加速 / 对称类归并）、相关均衡（CCE 检验 / 均衡间隙 / 向量化学习）、压缩距离（LZ77 / NCD LZ77 口径）、新奇检测（LOF / 半空间深度）、因果发现（GES lite）、扩散映射（地标嵌入 / 尺度扫描）、论证（VAF 听众语义）、世界模型（优先级扫描 / 随机表格 MDP）、选项（瓶颈态 / 关节点 / 选项自动生成）、安全屏障（多屏障合取）、安全策略改进（多重校正 / 多候选）、偏好学习（Plackett–Luce 全家）、自我对弈（弱点剖析 / 演化稳定性排名）、仿真校准（截断权重 / 加权 bootstrap）、元认知信心（meta-d′ MLE / 贝叶斯最优求助）、注意力经济（衰减源 / 退出年龄）、自我边界（增量列联 / 多步归因 / 他者模型）、弹性（Weibull / 可用性闭环 / 韧性预算）。集成脚本第 ③ 段对全部 80 符号做 `typeof` 分桶可达性断言——**收口不是「写进了文档」，是「运行时逐符号验证过」**。

## 138 脚本全量验证汇总

`npm run build` 成功（dist 2 files / 6.53 MB）；`npx tsc --noEmit` 0 错误；`scripts/` 下全部 138 个 `verify-*.mjs` 以 `node --experimental-transform-types` 逐一运行，**138/138 通过（退出码 0，0 FAIL）**。

### 第五轮新脚本（19 个，1,471 项断言）

| 脚本 | 覆盖组 | 断言数 | 结果 |
|------|--------|--------|------|
| verify-r5-statistics | R5-A1 统计推断（3.0/12.0/13.0/23.0/24.0） | 83 | PASS |
| verify-r5-causal | R5-A2 因果科学（5.0/10.0/11.0/77.0） | 78 | PASS |
| verify-r5-bayes | R5-A3 贝叶斯计算（6.0/26.0/27.0/57.0/58.0） | 60 | PASS |
| verify-r5-metacognition | R5-A4 元认知（7.0/8.0/9.0/96.0/97.0） | 91 | PASS |
| verify-r5-infogeo | R5-A5 信息几何（17.0/18.0/37.0/68.0/70.0） | 108 | PASS |
| verify-r5-planning | R5-A6 规划搜索（19.0/29.0/71.0/84.0/85.0） | 48 | PASS |
| verify-r5-decision | R5-A7 决策计算（21.0/22.0/51.0/52.0/53.0/73.0） | 77 | PASS |
| verify-r5-online | R5-A8 在线学习（31.0/65.0/74.0/75.0/88.0/89.0） | 74 | PASS |
| verify-r5-control | R5-A9 控制优化（32.0/34.0/35.0/43.0/54.0/87.0） | 90 | PASS |
| verify-r5-stochastic | R5-A10 随机过程（25.0/28.0/40.0/41.0/42.0/55.0） | 68 | PASS |
| verify-r5-spectral | R5-A11 谱方法（33.0/39.0/49.0/50.0/78.0/79.0） | 64 | PASS |
| verify-r5-topology | R5-A12 拓扑动力（36.0/38.0/66.0/69.0/76.0/91.0） | 81 | PASS |
| verify-r5-fairness | R5-A13 公平分配（16.0/44.0/45.0/60.0/63.0/99.0） | 92 | PASS |
| verify-r5-consensus | R5-A14 共识验证（15.0/20.0/46.0/47.0/48.0/56.0） | 71 | PASS |
| verify-r5-evolutionary | R5-A15 进化学习（14.0/59.0/67.0/92.0/93.0/98.0） | 103 | PASS |
| verify-r5-game | R5-A16 博弈机制（61.0/62.0/64.0/81.0/82.0/90.0） | 100 | PASS |
| verify-r5-learning | R5-A17 学习系统（30.0/72.0/80.0/83.0/86.0/94.0） | 68 | PASS |
| verify-r5-resilience | R5-A18 弹性自主（4.0/95.0/100.0） | 85 | PASS |
| verify-r5-integration | R5-A19 集成回归（跨组链 + 加速等价 + 80 符号导出面） | 30 | PASS |

其余 119 个存量脚本（0.9.0 基线，含 98 内核既有验证、第三轮 `verify-mod-*` 与第四轮 `verify-r4-*`）全部复验通过。

## 零回归承诺（延续）

本仓库的宪法在第五轮不变：**任何进化不得改变未启用它的既有行为**。

1. **等价证明先行**：轴 2 的每个加速路径都先证明与旧口径逐位（或解析容差）一致——播种二分 Gittins 全网格 |Δ| ≤ 2⁻²⁶、quickselect 中位数与排序逐位等价、learnCEFast 与 learnCE 逐位相同、引擎等价（counted vs scan 全字段一致）……「更快」从不是「可能不对」的借口；
2. **旧口径零漂移保留**：图割 SFMin / 严格收敛口径 / 档案精简策略等以新 API 或 opt-in 参数提供，缺省路径与升级前逐位一致（矩阵补全「旧收敛口径逐位保留 + 严格口径 opt-in」是范式样本）；
3. **确定性纪律**：全部 R5 脚本离线、确定性（mulberry32 种子固定、无 `Math.random` / `Date.now` 参与判定），同种子双跑逐位一致；耗时断言只取方向性并大实例化以抗负载抖动；
4. **诚实边界**：不可识别、吸引子塌缩、病态预警（GPD ξ ≥ 0.5、条件数 > 1e12）、退化为已知口径（FITC m = n ≡ 全 GP）——诚实上报而非假数。

## 五轮全景：0.5.0 → 1.0.0 里程碑线

- **0.5.0 基线**：48 质变内核（3.0 → 50.0，七大层）+ 三环自治 + 共生经济底座；
- **0.6.0 第一轮「创世纪」**：+25 内核（51.0 → 75.0）铺「每个模块能调用什么数学」，13 引擎接线，验证面扩至 62+19；
- **0.7.0 第二轮「自主本体」**：+25 内核（76.0 → 100.0，百数封顶）铺自主识别 / 判断 / 执行 / 进化 / 意识，14 引擎接线，验证面 81；
- **0.8.0 第三轮「全部模块世界性升级」**：18 模块域 × 4-6 项质级升级 + `src/telemetry/` 新模块，验证面 100；
- **0.9.0 第四轮「激活与深化」**：16 域 × 5 项全新维度 + `autonomy.modules.*` 16 旗标接进主链路 + 深化三件套 + 遥测二期，验证面 119；
- **1.0.0 第五轮「全部内核世界性进化」**：98 内核 × 四轴进化 + 80 新 API 根导出收口，验证面 **138 全绿**——内核 → 模块 → 主链路三层全部铺满并各自进化一遍，**百内核全进化里程碑收官**。
