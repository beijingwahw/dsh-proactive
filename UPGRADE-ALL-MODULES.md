# 第三轮升级公告（All Modules）：全部模块世界性升级

**版本 0.8.0**（自 0.7.0 升级）。主题：**「全部模块世界性升级」**——内核层铺完九十八个数学底座（3.0 → 100.0，百数封顶）之后，第三轮把升级面铺到**每一个模块域**：主链路全部引擎、全部基础设施与共生经济层，18 个模块域各 4-6 项质级升级，外加一个新模块（`src/telemetry/` 遥测审计总线）。全部升级 **opt-in、零漂移**——`attach*` 挂载或可选配置，不启用时系统行为与升级前逐位一致。

## 升级概览

- **升级面**：18 个模块域（哨兵 / 决策 / 调度 / 执行器 / 记忆 / 优化反思 / 自主 / 元认知 / 进化 / 世界模型 / 共生 / 分布式 / 治理 / 客户端 / 基准仪表盘 / 契约 / 主链路 / 遥测总线）× 每域 4-6 项升级，合计 99 项
- **新模块**：`src/telemetry/`（event-bus.ts / metrics.ts / audit-log.ts / trace.ts 四文件，已入 `dist` 导出与 `src/index.ts` re-export）
- **opt-in 方式**：全部经 `attach*` 挂载方法或可选配置（构造选项 / 方法参数），缺省即旧行为；不存在隐式改变行为的路径
- **验证**：新增 19 个离线验证脚本（18 个模块域 `verify-mod-*` + 1 个跨域集成 `verify-mod-integration`；合计离线验证脚本 **81 → 100**，全量复验 100/100 全绿，见下）
- **口径统一**：全套件验证脚本统一以 `node --experimental-transform-types` 运行（strip-types 的超集，兼容 `dsh-host.ts` 等使用 TS 参数属性的直连源脚本）；`verify-symbiosis` 完成确定化修复（去真定时器依赖）

## 18 域升级矩阵

| 域 | 升级项 | 验证锚点数字 | opt-in 方式 |
|----|--------|--------------|-------------|
| A1 哨兵（sentinel.ts） | 自适应聚合窗口三态（空闲收缩/常态/风暴保持）/ 紧急度半衰期衰减 / 每源令牌桶背压 / 级联溯源链防环（深链封顶）/ NCD 近重复合并 / 信号指纹统计 | 风暴滞留时延 5× 改善；空闲孤立信号 500ms → ~63ms 交付；41 级深链封顶 32 | 可选配置 `adaptiveWindow` / `urgencyHalfLifeMs` / `backpressure` + `attachFingerprintTracker()` |
| A2 决策（decision-engine.ts） | 决策滞后状态机（双阈值 + 最短驻留）/ 反事实决策台账（上下文桶 × 假想臂，Wilson 区间）/ ask-user 信息价值门（期望成本裁决）/ 上下文分桶校准 / 决策审计记录 | execute↔defer 边界横跳 −60%（9 → ≤5）；夜间漂移漏 defer 18 → 0；臂值差距收敛真值 0.76 | `attachDecisionHysteresis` / `attachCounterfactualLedger` / `attachAskUserValueGate` / `attachContextCalibrator` / `attachRationaleCapture` |
| A3 调度（model-scheduler.ts） | 健康路由熔断三态（EWMA 延迟/错误率 + 指数退避 + 半开探针）/ 两次选择幂 P2C 负载均衡（质量门过滤）/ 成本画像三档 / 每模型重试预算 / 调度审计 | 最大负载 31（P2C）< 35（纯随机）< 120（集中单点）；故障模型 10/10 被熔断换切 vs 旧 10/10 仍选中 | `attachHealthRouting` / P2C 配置 / 成本画像配置 / `attachRetryBudget` / `attachSchedulingAudit` |
| A4 执行器（task-executor.ts） | EDF 截止期调度（拓扑层内最早截止期优先）/ 尾延迟对冲（超 P95 并行副本先到先得）/ 计划级重试预算 / 取消传播 + 部分检查点续跑 / 执行审计 / 确定性虚拟时钟 | 截止期满足率 3/6 → 6/6；p99 300 → 87ms（成本 +10%）；重试风暴 10 → 7 调用；取消续跑省 40ms | `attachDeadlineScheduling` / `attachHedging` / 配置 `planRetryBudget` / 取消 API / `attachClock(VirtualClock)` |
| A5 记忆（memory/） | 热温冷三层存储（价值×频次×新近度综合分）/ 四路融合检索（关键词+图+别名+向量）/ 别名共现消歧 / 条目校验和 + 原子写 / 迁移 dry-run diff + 往返校验 / 记忆图度统计 | 热层命中率 0.64 vs 等容量单层 LRU 0.50；修复既有 `link()` 键拼接 bug | `attachTieredStorage` / `attachRetrievalFusion` / 校验和配置 / `migration.dryRun()` / `attachInfluenceRanking` |
| A6 优化反思轴（optimizer / reflector / reflection-engine） | 经验检索置信路由（置信×成功率×支撑度×时效）/ 推荐三维理由分解 / 重试 bandit（模型选择从固定规则到学习）/ 反事实 OPE 数据集 / 洞察去重衰减 / 沉淀价值评分 | 重试 bandit 总成本 −50%；陈旧高置信经验被新鲜度正确回退 | `attachRecallConfidenceRouting` / `attachRecommendationDecomposition` / `attachRetryBandit` / `attachCounterfactualLedger` / `attachInsightLedger` / `attachSedimentationScoring` |
| A7 自主轴（goal-engine / curiosity-engine / autonomy-loop） | 目标 DAG（依赖声明/拒环/就绪门）+ 预算与陈旧降级合并（前提失效并入健康同型目标）/ 价值 × 成功率排序 / 拓扑盲区定向好奇（挂 69.0 Mapper 盲区视图）/ 心跳五相位机 / 节奏自适应 / 相位预算让位 | 盲区定向命中 3/3 vs 无定向 0/3；停滞因子 0.25 精确断言 | 目标 DAG 字段 + `attachMapperBlindSpot` / `attachPhaseMachine` / `attachAdaptiveHeartbeat` |
| A8 元认知层（meta/） | 调参死区 + 斜坡 + 冷却稳定环 / 89.0 调整证书门（假改进 LCB<0 拒绝、冷启动保守半步）/ 自我变更日志 + 快照回滚 / 自我评估校准 / KPI 相对基线带（非绝对阈值）/ 内外环冲突仲裁 | 外环震荡 6 调 3 翻转 → 3 调 0 翻转；「假改进」臂被证书拒绝；早报 32 批次 0 误报 | 稳定环配置（stabilityLoop）/ 证书门配置 / `attachRelativeKpiBand` |
| A9 进化轴（strategy-evolution / policy） | 证书门进化环（沙盒跑分 → 88.0 OPE 反事实估值 → 89.0 LCB 证书 → 金丝雀观察窗 → 回滚，台账持久化）/ 对抗任务自适应难度 + 边界案例挖掘 / 进化谱系树 / 变异算子 softmax 治理 / 停滞重启多样化 / 进化预算 | 「表面分高但离线估值差」被 OPE 门拦截；观察窗漂移自动回滚 + 证书吊销 | `attachEvolutionBudget` / `attachOperatorGovernance` / `attachStagnationRestart` |
| A10 世界模型（world-model.ts / host） | 观测信念融合（源可靠性 Beta 学习 + 真冲突显式裁决不静默覆盖）/ 时间旅行快照 + 键级 diff / 宿主能力协商降级链 / 宿主桥五态 + 幂等键 / 世界健康度 | 噪声源键污染 10 → 0；矛盾源可靠性 Beta 0.5 → 0.25 在线衰减 | `attachObservationFusion` / `attachWorldHealth` / 快照 API |
| A11 共生经济（symbiosis/） | 订单簿不变量引擎 I1-I5（守恒/账实/无负持仓/订单簿一致/版税记账）/ LMSR 定价一致性（损失上界 ≤ b·ln2）/ 账本哈希链 + 篡改定位（修复折叠根缺陷）/ 信誉衰减 + 女巫抵抗 / 否决论证化 / 能源桑基导出 | 同窗刷分 209.9 → 29.98；随机订单流 10 轮撮合不变量恒成立 | 不变量引擎/LMSR 复核为纯函数；哈希链 / 信誉衰减 / 否决论证配置 |
| A12 分布式（consensus / sync / hot-reload） | Raft 种子化故障注入仿真台（四条安全不变量逐轮断言）/ 日志压缩快照（快照摘要 = 全量重放逐位）/ CRDT 反熵（状态差异 δ 同步）/ 热重载依赖拓扑闭包 / 原子交换回滚 | 500 轮混合故障风暴 0 安全违例；反熵传输 −87.5%；拓扑闭包 2/5 触碰 | 故障注入台为离线构造台；压缩 / 反熵 / 闭包配置 |
| A13 治理（tenant / security / safety-governor） | 极大极小水填充配额（44.0 口径）/ 吵闹邻居梯度抑制（软警告 → 硬拒绝 + 滞回解除）/ 信封加密密钥轮换宽限 / Shamir 5-3 托管（修复非 ASCII 乱码 bug）/ 总督行动阶梯 + 冷却 / 常量时间比较 | 4 租户水填充与手工解逐位对照 [2, 8/3, 8/3, 8/3]；饥饿场景无人饿死 | 配额配置 / 抑制配置 / `attachEscalationLadder` |
| A14 客户端（llm-client / progress-ws） | 去相关抖动退避（全抖动 × AWS 去相关混合）/ token 硬预算熔断 / 流式背压有界缓冲 / 进度合并终态必发 + 缺口检测 / offset 续传 / 调用审计 | 雪崩同步 std 0 → 165ms+（24 客户端同败对照）；10 万次重试延迟逐点有界 | 重试 / 预算 / 背压配置（llm-client options） |
| A15 基准仪表盘（benchmark / dashboard） | 符号检验 + 种子化 bootstrap CI / e-过程回归检测器（偷看免疫）/ BAI 聚焦（73.0 挂载复用）/ 结构化报告 / 98 内核地图 + GWT 总线 + 注意力市场三面板 | 名义 95% CI 经验覆盖 0.947；回归检测功效 0.95 且零误报；BAI 聚焦 0.988 vs 0.960 | `attachRegressionDetector`（+ 复用 attachBaiSelector / attachOcbaAllocator） |
| A16 契约（types / contracts / errors） | 13 码错误分类学（severity / retryability / 用户安全消息与内部诊断分离）/ 运行时校验器路径化错误 / 8 个品牌 ID / `Result<T,E>` 单子律（map/andThen/orElse）/ 事件信封守卫 | classifyTaxonomy 对旧式错误的就近归类全覆盖；单子律恒等式逐位 | 纯类型层 / 库函数新增，缺省不接线（零漂移天然成立） |
| A17 主链路（index.ts + engines-frontier） | 10 步审计轨迹环形缓冲（计时逐位可重放）/ 18 工具入参校验 + schema / 资源逆序释放审计 + 漏检告警 / introspect 三增量字段 / 4 适配器建议化 | PIPELINE_STEPS 1-10 唯一全覆盖；旗标总览恰 50 项；十二类非法入参全拒 | PipelineAuditTrail 注入 / 校验器显式调用 / introspect 只读增量 |
| A18 遥测总线（src/telemetry/ 新模块） | 结构化事件总线（类型化信封 / 通配订阅 / 环形缓冲 / 终态必达 / seq 缺口检测 / 慢订阅者背压三态）/ 指标注册表（分位数 / 基数护栏）/ 审计哈希链 / 跟踪跨度 | 60 步随机买卖等大量确定性断言（域内 133 项）；注入时钟逐位可重放 | 独立模块，经 `src/index.ts` 导出；缺省零挂载 |

**A19 集成回归**（收官代理）：前 18 域各自全绿之后，`verify-mod-integration.mjs` 做跨域联合冒烟——① 主链路五域纯数据流水（Sentinel 聚合 flush → DecisionEngine 双路裁决 → ModelScheduler 推荐 → TaskExecutor 注入执行 + 审计事件流 → Reflector 沉淀进真实 LongTermMemory）；② 遥测 × 契约口径对齐（A18 信封 × A16 品牌 ID）；③ 共生结算链上沉淀；④ dashboard 端点结构。全套件统一 `--experimental-transform-types` 运行口径；`verify-symbiosis` 确定化修复。

## 零漂移承诺

本仓库的宪法：**任何新数学不得改变未启用它的行为**。第三轮升级把这条宪法从「内核层」扩展到「全部模块层」：

1. **缺省即旧行为**：每项升级要么是显式 `attach*` 挂载（不调用即不存在），要么是可选配置（不配置即走原路径）——不存在「升级后默认变好也默认变了」的中间态；
2. **旧 vs 新构造对照**：每个域验证脚本的核心结构都是「旧行为 vs 新行为」在受控场景下的并排对照（例如 A3：故障模型在旧口径 10/10 仍被选中、新口径 0/10 换切；A14：24 客户端同败时旧固定退避全部同拍到达、新混合抖动分 24 拍）——验证的不是「改了」，是「证明更好」；
3. **确定性纪律**：全部域脚本离线、确定性——时钟注入（虚拟时钟 / 手动时钟）、随机源种子注入、网络端点 mock 化、真定时器清退；同种子双跑报告逐位一致；
4. **诚实降级**：未挂载的读数全部 `undefined`（不伪造默认值），冷启动/不可行场景诚实上报而非静默兜底。

## 与内核库（98 内核）的关系

第三轮不是又一个内核层，而是**让模块域大量消费既有内核挂载面**的世界性升级：

- A8 证书门直接消费 **89.0 安全策略改进**（LCB>0 才调参）；A9 进化环四门流水线串联 **88.0 离线评估**（OPE）与 **89.0**（LCB 证书）；
- A7 盲区定向好奇消费 **69.0 Mapper 图**的盲区视图；A15 结构化报告消费 **73.0 最佳臂识别** 与 **45.0 OCBA**；
- A6 反事实 OPE 数据集为 **88.0** 供给离线评估语料；A2 ask-user 信息价值门挂载 **95.0 中断交接** / **97.0 元认知信心**的裁决读数；
- A13 水填充配额按 **44.0 公平分配**口径自实现；A1 保留 **55.0 Hawkes** / **76.0 新奇检测** / **80.0 流式概要** / **99.0 注意力经济**的第二证据路径。

换言之：第一/二轮铺「每个模块能调用什么数学」，第三轮铺「每个模块本身值得拥有什么升级」——两层叠加后，挂载面从内核延伸到了模块行为本身。

## 100 脚本全量验证汇总

`npm run build` 成功（dist 2 files / 4.54 MB）；`npx tsc --noEmit` 0 错误；`scripts/` 下全部 100 个 `verify-*.mjs` 以 `node --experimental-transform-types` 逐一运行，**100/100 通过（退出码 0，0 FAIL）**。

### 第三轮新脚本（19 个，1,504 项断言）

| 脚本 | 覆盖 | 断言数 | 结果 |
|------|------|--------|------|
| verify-mod-sentinel | A1 | 61 | PASS |
| verify-mod-decision | A2 | 50 | PASS |
| verify-mod-scheduler | A3 | 97 | PASS |
| verify-mod-executor | A4 | 56 | PASS |
| verify-mod-memory | A5 | 67 | PASS |
| verify-mod-reflect | A6 | 69 | PASS |
| verify-mod-autonomy | A7 | 67 | PASS |
| verify-mod-meta | A8 | 32 | PASS |
| verify-mod-evolution | A9 | 19 | PASS |
| verify-mod-world | A10 | 121 | PASS |
| verify-mod-symbiosis | A11 | 90 | PASS |
| verify-mod-distributed | A12 | 60 | PASS |
| verify-mod-governance | A13 | 100 | PASS |
| verify-mod-client | A14 | 72 | PASS |
| verify-mod-bench-dash | A15 | 92 | PASS |
| verify-mod-contracts | A16 | 128 | PASS |
| verify-mod-pipeline | A17 | 142 | PASS |
| verify-mod-telemetry | A18 | 133 | PASS |
| verify-mod-integration | A19 集成回归 | 48 | PASS |

其余 81 个存量脚本（0.7.0 基线，含第一/二轮创世纪全部验证）全部复验通过。

## 如何启用

第三轮升级不新增统一配置命名空间——按模块域的原生方式 opt-in。示例：

```ts
// A3 调度：健康路由熔断 + P2C 负载均衡
scheduler.attachHealthRouting({ ewmaAlpha: 0.3, failureThreshold: 3 });
scheduler.attachSchedulingAudit();

// A4 执行器：EDF 截止期 + 尾延迟对冲 + 虚拟时钟
executor.attachDeadlineScheduling();
executor.attachHedging({ p95ThresholdMs: 2000, maxExtra: 1 });

// A1 哨兵：可选配置（构造或运行时）
// sentinel: { adaptiveWindow: {...}, urgencyHalfLifeMs: 10_000, backpressure: {...} }
```

每个接线点的「未挂载 = 旧行为逐位一致 / 挂载 = 生效」对照即活文档，见对应 `scripts/verify-mod-*.mjs`。
