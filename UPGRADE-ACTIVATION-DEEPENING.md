# 第四轮升级公告（Activation & Deepening）：激活与深化

**版本 0.9.0**（自 0.8.0 升级）。主题：**「激活与深化」**——第三轮给 18 个模块域装上「值得拥有的升级」之后，第四轮回答两个问题：**还能深多少**与**怎么真正跑起来**。16 个模块域各拿 5 项**全新维度**升级（约 80 项，不与第三轮重复），每项仍是「旧 vs 新」构造对照、opt-in、零漂移；同时把第三/四轮全部模块升级收敛为 `autonomy.modules.*` 16 旗标**接进主链路**（旗标开 = 挂载生效、全关 = 与升级前逐位一致），主链路自身加深化三件套，遥测总线完成二期。

## 升级概览

- **升级面**：16 个模块域（哨兵 / 决策 / 调度 / 执行器 / 记忆 / 优化反思 / 自主 / 元认知 / 进化 / 世界模型 / 共生 / 分布式 / 治理 / 客户端 / 基准仪表盘 / 契约）× 每域 5 项全新维度升级，合计约 80 项——全部是第三轮没有的新维度（共因判别 / 疲劳计量 / 组合优化 / 温度曲线 / 影子世界 / 拜占庭隔离 / 流动性度量……），不是第三轮项目的修补
- **激活接线（R4-17）**：`autonomy.modules.*` 16 旗标统一开关（与 `kernels.*` 同款风格）——第三/四轮各模块的 `attach*` 挂载与构造配置注入收敛进主链路；旗标 → attach 差分验证（开 = 新读数出现且生效、关 = 新读数缺席且行为逐位不变），全关零漂移
- **主链路深化（R4-17）**：跨步骤缓存（纯函数 LRU 记忆化，命中与直算逐位一致）/ 降级阶梯（第 5/6 步异常三级按序降级 + 兜底一致）/ 步骤预取（执行等待期预取，代际守卫消费恒一致）
- **遥测二期（R4-18）**：滑动窗口聚合 / 确定性采样（Bresenham，错误必达、估计器还原）/ Prometheus 文本导出 / 双门限保留（链锚定校验）/ 跟踪尾部采样
- **验证**：新增 19 个离线验证脚本（16 个域 `verify-r4-*` + 主链路 `verify-r4-pipeline` + 遥测 `verify-r4-telemetry` + 集成 `verify-r4-integration`），合计 **1,737 项断言**；离线验证脚本总数 **100 → 119**，全量复验 **119/119 全绿**
- **确定性纪律**：全套件延续 `node --experimental-transform-types` 统一口径；第四轮脚本全部注入时钟 / 种子化随机（共生集成以冻结时钟根治 wall-clock 依赖）

## 16 域升级矩阵

| 域 | 升级项（每域 5 项全新维度） | 验证锚点数字 | 激活方式 |
|----|------------------------------|--------------|----------|
| R4-1 哨兵（sentinel.ts） | 共因爆发检测（同刻齐发巧合对 lift 判别 + common-cause 聚类）/ 周期画像（自相关周期锁定 + period-miss 漏报注入 + 早到晚到偏差记账）/ 级联优先级继承（代际衰减 + 放大封顶）/ 源质量反馈（计分 + autoDiscount 打折）/ 风暴预算共享（风暴期令牌桶联动收紧） | 共因组 lift 3.85（独立期望 6.76 对 vs 观测 26 对）vs 独立组 ≈1.0（≤1.9 阈下不误报）；静默 3.2 周期漏报 0 条 → 按周期注入 period-miss；40 代自报 0.99 恒定 → 0.9×0.6^k（0.54 → 0.324 → 0.1944）；有效信号排位 4.0 → 2.0；风暴期接纳 31 → 19（溢出 89 → 101，风暴后预算内全接纳） | 构造配置（`modules.sentinelAdaptive` 汇入） |
| R4-2 决策（decision-engine.ts） | 批量联合决策（同型信号合并共担 strategist）/ 决策疲劳计量（付费决策限额 + 冷却）/ 失败模式聚类（Top-3 模式 + 精确恢复建议）/ 决策路径解释器（输入→特征→规则→裁决逐字段）/ 撤销协议（三态） | strategist 10 → 1 次、成本 −58.5%；付费决策 30 → 10；Top-3 精确恢复；解释器逐字段一致 | `modules.decisionHysteresisJoint`（attachDecisionHysteresis + attachBatchJointDecider） |
| R4-3 调度（model-scheduler.ts） | 集成组合优化（候选集成 Condorcet 裁决）/ 预测性预热（到达预测提前升温）/ 冷启动三阶段准入（影子→金丝雀→毕业）/ 成本漂移告警 / 特长画像（模型 × 任务专长路由） | Condorcet 组合 0.6576 > 最优单体 0.62；预热提前 2010ms；劣质新模型 10/10 → 0/10 被准入；特长命中 50% → 100% | `modules.schedulerColdStart`（attachAdmissionProtocol + attachPrewarm） |
| R4-4 执行器（task-executor.ts） | 并行度自适应（批宽随成功率 / 失败率调节）/ 失败域隔离（(model,taskType) 细粒度熔断）/ ETA 分位估计 / 计划压缩（语义等价节点合并）/ 失败注入演练 | 自适应收敛并发 3、总耗时 −59%；无辜迁移 5 → 0；ETA 误差 885% → 8.2%；计划 6 → 4 节点语义等价 | `modules.executorAdaptiveParallelism` / `modules.executorFailureDomains` |
| R4-5 记忆（memory/） | 冲突仲裁（新旧证据强度比裁决、旧观点留档不覆盖）/ 老化温度曲线（保温 vs 荒废非线性分档）/ 因果链溯源 / 健康审计（缺陷扫描）/ 跨任务迁移映射（Wilson 下界学习可迁移对 + 结构回退） | 新证据胜出且旧观点留档；保温 0.439 vs 荒废 0.051（Δ=0.388 分岔，同库极差 0.894）；5 类缺陷全检出；可迁移对 0.596 vs 不可迁移 0.036（16 倍，均与 oracle 手算一致） | attach*（分层 / 仲裁归 `modules.memoryTieredArbitration`） |
| R4-6 优化反思轴（optimizer / reflector / reflection-engine） | 跨任务经验迁移（相似度 × 质量三重门槛）/ 反思深度分级（轻量→标准→深度升级链）/ 失败知识库（同模式二次失败规避）/ 置信度传播 / 计划模板抽象 | 深度分级成本省 25%；轻 → 重升级链按需触发；同模式二次失败规避（effectiveness = 1） | attach* |
| R4-7 自主轴（goal / curiosity / autonomy-loop） | 目标资源冲突检测（DAG 资源缺口）/ 探索预算自适应（成效驱动方向增减）/ 动作安全三级（read / write / mutate 证书门）/ 里程碑延误侦测 / 时段治理（跨午夜窗口） | 资源缺口 2 检出 0 误报；探索方向 3 → 4 → 1 收敛正确；mutate 无证书 fail-closed；跨午夜窗口正确归属 | attach* / 可选配置 |
| R4-8 元认知层（meta/） | 多尺度监控（毛刺 = 波动 vs 真退化三段演进判别）/ 自我效能预测（任务族 Beta 后验分化 + 校准）/ 认知负荷门（并发调整上限）/ 调整幅度元学习（翻车收缩、成功放宽）/ KPI 相关图（联动检出 + 调整影响面） | 三段演进区分毛刺与真退化；效能分化误差 ≤ 0.03、校准收敛；负荷门拦截并发调整且判定不作废；幅度元学习逃脱旧口径死锁 | `modules.metaStabilityLoop`（构造注入） |
| R4-9 进化轴（strategy-evolution / policy） | 多样性仪表（基因距离 / niche 监控 + 坍缩预警 + 注入建议）/ 跨任务策略迁移（第 1 代即部署 + 无益迁移识别弃用）/ 速率自适应（平稳降频、突变立即）/ A/B 分支谱系（确定性 20% 分流 + 双侧证书晋升淘汰）/ 冻结协议 | 预警先于最深坍缩 3 代（首警第 5 代 0.2601 < 最深第 8 代 0.0278）、注入后多样性 8.2 倍（0.2277 vs 0.0278）；迁移第 1 代即部署 +0.22；确定性 20% 分流 | `modules.policyABBranching`（attachABBranching）等 |
| R4-10 世界模型（world-model.ts / host） | 反事实影子世界（0 污染三方归因）/ 不确定性地图（已知 / 未知四分区）/ 多假说竞技场（证据翻转排序）/ 事件因果链账本 / 宿主桥池（坏宿主 0 执行） | 影子世界对主状态 0 污染；四分区未知率 0.3 可视；证据到位排序翻转；坏宿主调用 0 执行 | `modules.worldObservationFusion` 等 attach* |
| R4-11 共生经济（symbiosis/） | 流动性度量（价差 / 深度 / 滑点 bps）/ 通胀治理（流通量目标带 + 铸币税调节）/ 贡献者画像 + 突变检测 / 条件结算合约（三路结算托管守恒）/ 操纵检测（对敲 + 循环成交） | 薄 / 厚簿价差 1818 vs 168bps（深度 190 vs 888，同规模滑点 20.0% vs 0.8%）；超发 3 次结算回归带内、分红 40 → 20；托管守恒恒成立；对敲 + 循环成交全部检出 | `modules.symbiosisEconomy`（monetaryPolicy + attachConditionalSettlement） |
| R4-12 分布式（consensus / sync / hot-reload） | 拜占庭检测隔离（三类证据计数 + 法定人数排除 + 申诉再犯回隔离 + 治愈恢复）/ 分区愈合报告（少数侧截断显式入账）/ 单步成员变更（联合共识双法定人数）/ 跨集群联邦（前缀订阅选择性同步 + 窗口限流）/ 热重载灰度（探针渐进） | 隔离后 5 → 4 节点照常提交；截断段显式入账非静默丢弃；3 → 5 → 4 全程无双主、日志 1..8 连续；联邦 3205 B vs 全量 4146 B（77.3%）+ 未订阅前缀零传输；坏版本只回滚灰度单元、其余模块零触碰 | 配置 / 独立构造台 |
| R4-13 治理（tenant / security / safety-governor） | 配额预测（EWMA + 最小二乘斜率外推预警）/ 密钥分级（low/medium/high 差异化轮换 + 错级告警 / 拒绝）/ 事件取证时间线（三重核验）/ 合规导出（SHA-256 摘要）/ 威胁评分跳档（高危直达） | 预警提前 1000ms 且零误报；错级使用告警；取证三重核验通过；合规摘要逐位一致；高危 1 次直达 vs 旧口径 4 次告警 3 次冷却 | `modules.tenantQuotaForecast` / `modules.cryptoTieredKeys` |
| R4-14 客户端（llm-client / progress-ws） | 模型能力探测（失败不虚标）/ 优先级队列（高优先先出 + 抢占继承 + 排队超时）/ 流式续传（offset 断点重传 + 协议不支持诚实回退）/ 快照 + 增量无缝 / 成本对账（账单差异检出） | 断点续传净增 8 字符 vs 全量重发 20 字符（−60%）；能力探测失败项诚实不虚标；对账差异检出 | `modules.clientPriorityQueue`（构造注入） |
| R4-15 基准仪表盘（benchmark / dashboard） | 长期趋势追踪（Theil–Sen 斜率 + Mann–Kendall 显著性）/ 模型推荐引擎（查表 + 插值 + 诚实回退）/ 对比矩阵（显著性标记与逐对检验一致）/ 统一告警面板 / 布局持久化 | 平稳流 48 种子 0 误报（名义 α=0.05；旧两点差分 12/19 步喊「变化」）；推荐 12/12 vs 随机 2/12 | `modules.benchmarkTrendTracker` / `modules.dashboardAlarmSources` |
| R4-16 契约（types / contracts / errors） | API 语义版本协商 / 模式演化链（升降级诚实审计）/ 声明式不变量库 / 类型依赖图（拓扑排序 + 环检测 + DOT 导出）/ 错误重试策略四分法 | 15 组版本协商组合矩阵全覆盖；依赖图拓扑序成立且环被检出 | 纯类型 / 库函数新增（零漂移天然成立） |

**R4-17 主链路（激活接线 + 深化三件套，index.ts + engines-frontier/autonomy25.ts）**：① `autonomy.modules.*` 16 旗标把第三/四轮模块升级接进主链路——旗标 → attach 差分验证（开 = 挂载且新读数出现、关 = 不挂载且行为逐位一致），全关零漂移，`manage_autonomy introspect` 新增 `moduleFlags` 总览（16 旗标开关态 + wave/entry 元数据）与 `pipelineDeepening` 读数；② 跨步骤缓存（信号指纹 / 任务上下文推断的纯函数 LRU 记忆化，命中与直算逐位一致）；③ 降级阶梯（第 5/6 步异常时主路径 → 简化路径 → 兜底直通三级按序，兜底结果与正常路径口径一致）；④ 步骤预取（执行等待期预取下一信号的经验检索，代际守卫消费——62 → 50 单位、零陈旧消费）。

**R4-18 遥测二期（src/telemetry/）**：滑动窗口聚合（分位数 / 计数在线滚动）/ 确定性采样（Bresenham 直线插值——错误事件必达、采样率还原经估计器校验）/ Prometheus 文本导出（`# HELP/# TYPE` 规范口径）/ 双门限保留（热 / 温 / 冷层级 + 审计哈希链锚定校验）/ 跟踪尾部采样（错误跨度保留、正常跨度按率）。

**R4-19 集成回归（收官）**：五段联合冒烟（55 断言）——① 激活链路（16 旗标开 / 关差分贯通主链路）；② 感知 → 决策 → 执行纯数据流水；③ 经济-治理-遥测（共生结算 × 配额 × 事件信封）；④ dashboard 端点结构；⑤ Prometheus 导出 + 审计保留链。附带根治 `verify-symbiosis` 的 wall-clock 依赖（注入冻结时钟，双跑逐位一致）。

## 激活接线：`autonomy.modules.*` 16 旗标用法

第四轮起，模块域升级不再需要逐引擎调用 `attach*`——统一经配置开关（缺省全关 = 与升级前逐位一致）。16 旗标静态清单（`MODULE_FLAGS`，与 `ModuleUpgradeFlags` 一一对应，旗标名以 `src/index.ts` / `src/engines-frontier/autonomy25.ts` 为准）：

| 旗标 | 目标模块 | 轮次 | 挂载面 |
|------|----------|------|--------|
| `modules.sentinelAdaptive` | sentinel | 3 | ctor: adaptiveWindow + stormBudget |
| `modules.decisionHysteresisJoint` | decision-engine | 4 | attachDecisionHysteresis + attachBatchJointDecider |
| `modules.schedulerHealthRouting` | model-scheduler | 3 | attachHealthRouting |
| `modules.schedulerColdStart` | model-scheduler | 4 | attachAdmissionProtocol + attachPrewarm |
| `modules.executorAdaptiveParallelism` | task-executor | 4 | attachAdaptiveParallelism |
| `modules.executorFailureDomains` | task-executor | 4 | attachFailureDomains |
| `modules.memoryTieredArbitration` | long-term-memory | 3 | attachTieredStorage + attachArbiter |
| `modules.metaStabilityLoop` | meta-controller | 4 | ctor: stabilityLoop |
| `modules.policyABBranching` | policy-evolver | 4 | attachABBranching |
| `modules.worldObservationFusion` | world-model | 4 | attachObservationFusion |
| `modules.symbiosisEconomy` | symbiosis | 4 | ctor: monetaryPolicy + attachConditionalSettlement |
| `modules.cryptoTieredKeys` | crypto-engine | 4 | ctor: tiered |
| `modules.tenantQuotaForecast` | tenant-manager | 4 | configureQuotaForecast |
| `modules.clientPriorityQueue` | llm-client | 4 | ctor: priorityQueue |
| `modules.benchmarkTrendTracker` | benchmark | 4 | attachTrendTracker |
| `modules.dashboardAlarmSources` | dashboard | 4 | attachDashboard: sources.getAlarms |

（第三轮 18 域中未入表的域——反思轴 / 自主轴 / 分布式 / 契约 / 主链路 / 遥测——的升级按各自原生 attach / 配置 opt-in，与其 `verify-mod-*` / `verify-r4-*` 脚本一致。）

示例（dsh 用户层 `cordis.patch.yml` 覆盖行；bundle 层缺省值即全关，照抄改 `enabled` 即可）：

```yaml
autonomy:
  modules:
    # 调度：冷启动三阶段准入 + 周期预热（第四轮）
    schedulerColdStart:
      enabled: true
    # 执行器：失败域隔离（第四轮）
    executorFailureDomains:
      enabled: true
      failureThreshold: 2
      cooldownMs: 60000
    # 共生：流通量目标带 + 条件结算（第四轮）
    symbiosisEconomy:
      enabled: true
      targetCirculating: 200
  pipeline:
    # 主链路深化三件套（纯性能 / 韧性，结果恒一致）
    crossStepCache:
      enabled: true
      capacity: 256
    degradationLadder:
      enabled: true
    stepPrefetch:
      enabled: true
```

开启后 `manage_autonomy { "action": "introspect" }` 返回 `moduleFlags`（`total: 16` + 各旗标 `enabled` / `wave` / `entry`）与 `pipelineDeepening`（缓存命中统计 / 降级次数 / 预取统计）。「旗标关 = 现状逐位不变 / 旗标开 = 挂载生效」的差分对照即活文档：`scripts/verify-r4-pipeline.mjs`（97 断言）。

## 零漂移承诺（延续）

本仓库的宪法在第四轮不变：**任何新数学 / 新机制不得改变未启用它的行为**。

1. **缺省即旧行为**：16 旗标 + `pipeline.*` 三开关全部缺省关闭——`modules.*` 全关时 `attach*` 不挂载、构造配置片段为 `{}`（零注入）；
2. **旧 vs 新构造对照**：每个域的 R4 脚本核心结构仍是受控场景并排对照（如哨兵共因组 lift 3.85 vs 独立组 ≈1.0、执行器无辜迁移 5 → 0）——验证的不是「改了」，是「证明更好 / 判别正确」；
3. **确定性纪律**：全部 R4 脚本离线、确定性（注入时钟 / 种子化随机 / mock 端点），同种子双跑逐位一致；
4. **诚实降级**：未启用的读数 `undefined`（不伪造默认值），不可行 / 不支持场景诚实上报（如流式续传协议不支持时诚实回退）。

## 与前三轮的关系

- **第一 / 二轮（98 内核，3.0 → 100.0）**：铺「每个模块**能调用什么数学**」——98 个数学内核 + `kernels.*` 旗标挂载面；
- **第三轮（v0.8.0，全部模块世界性升级）**：铺「每个模块**本身值得拥有什么升级**」——18 域 × 4-6 项（attach / 可选配置，散装 opt-in）+ `src/telemetry/` 新模块；
- **第四轮（v0.9.0，激活与深化）**：① 16 域再各 5 项**全新维度**（约 80 项，深化）；② 把三轮散装的 attach 收敛为 `autonomy.modules.*` 16 旗标**接进主链路**（激活——从「库里有」到「链路上跑」），主链路自身加缓存 / 降级 / 预取深化，遥测二期补齐观测出口。

三层叠加后的完整链路：**内核提供数学 → 模块提供行为升级 → 旗标把升级接进主链路**。每一步都保持零漂移：三层全关时，系统行为与 0.5.0 基线逐位一致。

## 119 脚本全量验证汇总

`npm run build` 成功（dist 2 files / 5.41 MB）；`npx tsc --noEmit` 0 错误；`scripts/` 下全部 119 个 `verify-*.mjs` 以 `node --experimental-transform-types` 逐一运行，**119/119 通过（退出码 0，0 FAIL）**。

### 第四轮新脚本（19 个，1,737 项断言）

| 脚本 | 覆盖 | 断言数 | 结果 |
|------|------|--------|------|
| verify-r4-sentinel | R4-1 哨兵 | 53 | PASS |
| verify-r4-decision | R4-2 决策 | 102 | PASS |
| verify-r4-scheduler | R4-3 调度 | 80 | PASS |
| verify-r4-executor | R4-4 执行器 | 73 | PASS |
| verify-r4-memory | R4-5 记忆 | 88 | PASS |
| verify-r4-reflect | R4-6 反思轴 | 87 | PASS |
| verify-r4-autonomy | R4-7 自主轴 | 97 | PASS |
| verify-r4-meta | R4-8 元认知 | 89 | PASS |
| verify-r4-evolution | R4-9 进化轴 | 49 | PASS |
| verify-r4-world | R4-10 世界模型 | 144 | PASS |
| verify-r4-symbiosis | R4-11 共生经济 | 68 | PASS |
| verify-r4-distributed | R4-12 分布式 | 88 | PASS |
| verify-r4-governance | R4-13 治理 | 87 | PASS |
| verify-r4-client | R4-14 客户端 | 81 | PASS |
| verify-r4-bench-dash | R4-15 基准仪表盘 | 138 | PASS |
| verify-r4-contracts | R4-16 契约 | 161 | PASS |
| verify-r4-pipeline | R4-17 激活接线 + 深化 | 97 | PASS |
| verify-r4-telemetry | R4-18 遥测二期 | 100 | PASS |
| verify-r4-integration | R4-19 集成回归 | 55 | PASS |

其余 100 个存量脚本（0.8.0 基线，含 98 内核全部验证与第三轮 `verify-mod-*`）全部复验通过。
