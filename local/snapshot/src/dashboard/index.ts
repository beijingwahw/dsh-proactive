/**
 * dashboard/index.ts — 实时仪表盘服务端（集成层前端组件）
 *
 * 职责：将自包含的仪表盘页面挂载到 ProgressBroadcaster 的 HTTP 端口
 * - GET /            → 仪表盘页面（内嵌 WebSocket 客户端，自动重连）
 * - GET /api/model-status → 模型运行时状态 JSON（5s 轮询数据源）
 * - GET /api/kernel-map   → 98 内核 × 20 层地图 + 旗标开关态（第三轮 A15）
 * - GET /api/gwt-bus      → 96.0 意识总线最近广播流（第三轮 A15）
 * - GET /api/attention-market → 99.0 注意力市场槽位分配与支付（第三轮 A15）
 * - GET /api/alarm-feed   → 实时告警统一视图（?source= 按类型过滤；第四轮 R4）
 * - 其余请求        → 交回 progress-ws 默认健康检查
 *
 * 设计约束：零第三方依赖、零外部静态资源，单 HTML 文件随插件打包。
 *
 * 第三轮 A15 升级（数据绑定面——introspect / 意识总线 / 注意力市场）：
 * - attachDashboard 第三参数 sources 为可选注入：未注入时三个新端点
 *   返回 available:false 空态（零漂移——既有两参调用完全兼容）；
 * - 载荷构造全部为纯函数（kernelMapPayload / gwtBusPayload /
 *   attentionMarketPayload），验证脚本可离线单测绑定口径；
 * - KERNEL_LAYER_MAP 为 98 内核（3.0→100.0 百数封顶）× 20 层的静态
 *   总览数据，旗标名与 src/index.ts KERNEL_FLAGS（51.0→100.0 五十旗标）
 *   一一对应；3.0→50.0 为常驻内核（无旗标，恒开）。
 *
 * 第四轮 R4-A15 升级（激活与深化）：
 * - 实时告警面板：alarmFeedPayload 把回归检测器（benchmark e-过程）/
 *   安全总督 / 元认知 KPI 三源告警统一为一张按时间倒序、按严重度分色
 *   （critical 红 / warning 黄 / info 蓝）、可按来源过滤的告警流；
 *   sources.getAlarms 可选注入，未注入 → available:false 空态（零漂移）；
 * - 自定义布局持久化：DASHBOARD_LAYOUT_STORAGE_KEY + serialize /
 *   parseDashboardLayout / visibleOrderedPanels 纯函数——面板显隐与顺序
 *   的用户偏好（localStorage 键，纯前端）：序列化往返恒等、坏输入回退
 *   默认、未知面板 id 过滤、缺失面板按默认序补齐（离线可测的纯函数契约，
 *   HTML 内嵌脚本按同键读写）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProgressBroadcaster } from '../progress-ws.js';
import type { ModelRuntimeStatus } from '../llm-client.js';

// ═══════════════════════════════════════════════════════════════════
// 第三轮 A15：数据绑定类型（dashboard 侧契约——宿主注入，未注入空态）
// ═══════════════════════════════════════════════════════════════════

/** 内核旗标绑定（introspect 导出口径的最小面：旗标名 + 版本 + 开关态） */
export interface KernelFlagBinding {
  /** 旗标名（与 src/index.ts KERNEL_FLAGS 命名一致，如 baiSelector） */
  name: string;
  /** 版本号（如 '73.0'） */
  version: string;
  /** 开关态（仅显式 === true 视为开——与 kernelFlagOverview 同口径） */
  enabled: boolean;
}

/** GWT 广播行绑定（96.0 意识总线——胜者 / 优先级 / 点火） */
export interface GwtBroadcastBinding {
  /** 心跳步序 */
  step: number;
  /** 胜者引擎 id（未点火 undefined） */
  winner?: string;
  /** 点火时刻有效投标（优先级；未点火 undefined） */
  effectiveBid?: number;
  /** 广播内容标签 */
  tags: string[];
  /** 是否点火 */
  ignited: boolean;
}

/** GWT 意识总线绑定（96.0 视图——最近广播流 + 胜者分布） */
export interface GwtBusBinding {
  /** 累计步数 */
  steps: number;
  /** 点火率（意识负荷 KPI） */
  ignitionRatio: number;
  /** 胜者分布熵 bit（监控垄断） */
  entropy: number;
  /** 各引擎胜场 */
  winCounts: ReadonlyArray<{ id: string; wins: number }>;
  /** 最近广播流（步序降序由 payload 统一保证） */
  recentBroadcasts: ReadonlyArray<GwtBroadcastBinding>;
}

/** 注意力市场绑定（99.0 视图——槽位分配与 VCG 支付） */
export interface AttentionMarketBinding {
  /** 深看槽位总数 k */
  slots: number;
  /** 逐槽胜出轨迹（按边际降序） */
  awards: ReadonlyArray<{ sourceId: string; slotNumber: number; marginal: number }>;
  /** 各源 VCG（Clarke pivot）支付 */
  payments: ReadonlyArray<{ sourceId: string; payment: number }>;
  /** 统一边际价格（第 k+1 高边际——信息饥渴的影子价格） */
  marginalPrice: number;
  /** 空置槽位 */
  idleSlots: number;
  /** 拍卖收入 Σ payments */
  revenue: number;
  /** 读数句（可选） */
  insight?: string;
}

/** 三个新面板的数据源注入（全部可选——未注入空态，零漂移） */
export interface DashboardExtraSources {
  /** 内核旗标开关态（introspect / kernelFlagOverview 口径） */
  getKernelFlags?: () => ReadonlyArray<KernelFlagBinding> | undefined;
  /** 96.0 意识总线视图 */
  getGwtBus?: () => GwtBusBinding | undefined;
  /** 99.0 注意力市场视图 */
  getAttentionMarket?: () => AttentionMarketBinding | undefined;
  /**
   * 第四轮 R4-A15：统一告警流（回归检测器 / 安全总督 / 元认知 KPI 等三源
   * 汇聚；未注入 → /api/alarm-feed 空态——零漂移）。
   */
  getAlarms?: () => ReadonlyArray<DashboardAlarmBinding> | undefined;
}

// ═══════════════════════════════════════════════════════════════════
// 98 内核 × 20 层静态地图（编号 3.0→100.0；旗标名 51.0→100.0 与
// src/index.ts KERNEL_FLAGS 一一对应；3.0→50.0 常驻无旗标）
// ═══════════════════════════════════════════════════════════════════

interface KernelMetaRow {
  version: string;
  name: string;
  /** 旗标名（51.0→100.0）；缺省 = 常驻内核（无旗标） */
  flagName?: string;
}

interface KernelLayerRow {
  /** 层序（1 起——意识层为第 20 层，与 UPGRADE-AUTONOMY25.md 同口径） */
  index: number;
  /** 层名（1–4 层为 dashboard 侧标注：3.0→20.0 先于命名层时代） */
  name: string;
  kernels: ReadonlyArray<KernelMetaRow>;
}

/** 98 内核 × 20 层总览（静态数据：编号 / 名称 / 旗标名） */
export const KERNEL_LAYER_MAP: ReadonlyArray<KernelLayerRow> = [
  {
    index: 1,
    name: '证据层',
    kernels: [
      { version: '3.0', name: '证据' },
      { version: '4.0', name: '弹性' },
      { version: '5.0', name: '因果' },
    ],
  },
  {
    index: 2,
    name: '深思层',
    kernels: [
      { version: '6.0', name: '自由能' },
      { version: '7.0', name: '深思' },
      { version: '8.0', name: '元推理' },
      { version: '9.0', name: '抽象' },
      { version: '10.0', name: '科学家' },
    ],
  },
  {
    index: 3,
    name: '先验层',
    kernels: [
      { version: '11.0', name: '理论家' },
      { version: '12.0', name: '任意时刻证据' },
      { version: '13.0', name: '保形预测' },
      { version: '14.0', name: '质量-多样性' },
      { version: '15.0', name: '运行时验证' },
    ],
  },
  {
    index: 4,
    name: '几何拓扑层',
    kernels: [
      { version: '16.0', name: 'Shapley 归因' },
      { version: '17.0', name: '最优传输' },
      { version: '18.0', name: '信息几何' },
      { version: '19.0', name: '最优停止' },
      { version: '20.0', name: '层论共识' },
    ],
  },
  {
    index: 5,
    name: '创世层',
    kernels: [
      { version: '21.0', name: 'Gittins' },
      { version: '22.0', name: '预算 Knapsack' },
      { version: '23.0', name: '稳健统计' },
      { version: '24.0', name: '差分隐私' },
      { version: '25.0', name: '容量规划' },
    ],
  },
  {
    index: 6,
    name: '先知层',
    kernels: [
      { version: '26.0', name: '高斯过程' },
      { version: '27.0', name: '卡尔曼滤波' },
      { version: '28.0', name: '极值理论' },
      { version: '29.0', name: '蒙特卡洛树搜索' },
      { version: '30.0', name: '次模优化' },
    ],
  },
  {
    index: 7,
    name: '均衡层',
    kernels: [
      { version: '31.0', name: '对抗无悔学习' },
      { version: '32.0', name: '全局指派' },
      { version: '33.0', name: '随机矩阵' },
      { version: '34.0', name: 'CVaR 分布鲁棒' },
      { version: '35.0', name: 'LQR 反馈控制' },
    ],
  },
  {
    index: 8,
    name: '觉醒层',
    kernels: [
      { version: '36.0', name: '持续同调' },
      { version: '37.0', name: '信息瓶颈' },
      { version: '38.0', name: '非线性动力学' },
      { version: '39.0', name: 'PageRank 谱排序' },
      { version: '40.0', name: '首达时间' },
    ],
  },
  {
    index: 9,
    name: '川流层',
    kernels: [
      { version: '41.0', name: 'Jackson 排队网络' },
      { version: '42.0', name: 'FFT 谱周期' },
      { version: '43.0', name: '最大流' },
      { version: '44.0', name: '极大极小公平' },
      { version: '45.0', name: 'OCBA 预算分配' },
    ],
  },
  {
    index: 10,
    name: '经纬层',
    kernels: [
      { version: '46.0', name: '法定人数' },
      { version: '47.0', name: 'CRDT' },
      { version: '48.0', name: 'Shamir 共享' },
      { version: '49.0', name: 'Haar 小波' },
      { version: '50.0', name: '矩阵补全' },
    ],
  },
  {
    index: 11,
    name: '奇点层',
    kernels: [
      { version: '51.0', name: '投机解码', flagName: 'speculativeDecoding' },
      { version: '52.0', name: '测试时计算', flagName: 'testTimeCompute' },
      { version: '53.0', name: 'Whittle 指数', flagName: 'whittleIndex' },
      { version: '54.0', name: 'Lyapunov 背压', flagName: 'lyapunovBackpressure' },
      { version: '55.0', name: 'Hawkes 自激发', flagName: 'hawkesBurstGuard' },
    ],
  },
  {
    index: 12,
    name: '心智层',
    kernels: [
      { version: '56.0', name: '置信传播', flagName: 'beliefPropagation' },
      { version: '57.0', name: '变分推断', flagName: 'variationalInference' },
      { version: '58.0', name: '朗之万采样', flagName: 'langevinMutation' },
      { version: '59.0', name: '课程学习', flagName: 'curriculum' },
      { version: '60.0', name: '率失真', flagName: 'rateDistortion' },
    ],
  },
  {
    index: 13,
    name: '博弈层',
    kernels: [
      { version: '61.0', name: '稳定匹配', flagName: 'stableMatching' },
      { version: '62.0', name: '机制设计', flagName: 'mechanismDesign' },
      { version: '63.0', name: '核仁', flagName: 'nucleolusAudit' },
      { version: '64.0', name: '相关均衡', flagName: 'correlatedEquilibrium' },
      { version: '65.0', name: '动态定价', flagName: 'dynamicPricing' },
    ],
  },
  {
    index: 14,
    name: '突现层',
    kernels: [
      { version: '66.0', name: '模拟退火', flagName: 'annealingEscape' },
      { version: '67.0', name: 'NSGA-II 帕累托', flagName: 'paretoFront' },
      { version: '68.0', name: '压缩距离', flagName: 'compressionDistance' },
      { version: '69.0', name: 'Mapper 图', flagName: 'mapperGraph' },
      { version: '70.0', name: '部分信息分解', flagName: 'pidDiagnostics' },
    ],
  },
  {
    index: 15,
    name: '证明层',
    kernels: [
      { version: '71.0', name: 'A* 搜索', flagName: 'astarSearch' },
      { version: '72.0', name: '稀疏恢复', flagName: 'sparseRecovery' },
      { version: '73.0', name: '最佳臂识别', flagName: 'baiSelector' },
      { version: '74.0', name: '镜像下降', flagName: 'mirrorDescent' },
      { version: '75.0', name: '在线校准', flagName: 'onlineCalibration' },
    ],
  },
  {
    index: 16,
    name: '感知层',
    kernels: [
      { version: '76.0', name: '新奇检测', flagName: 'noveltySentinel' },
      { version: '77.0', name: '因果发现', flagName: 'causalDiscovery' },
      { version: '78.0', name: '多源对齐', flagName: 'ccaAlignment' },
      { version: '79.0', name: '流形学习', flagName: 'diffusionManifold' },
      { version: '80.0', name: '流式概要', flagName: 'streamingSketch' },
    ],
  },
  {
    index: 17,
    name: '判断层',
    kernels: [
      { version: '81.0', name: '论证', flagName: 'argumentation' },
      { version: '82.0', name: '众包聚合', flagName: 'crowdAggregation' },
      { version: '83.0', name: '世界模型学习', flagName: 'worldModelLearning' },
      { version: '84.0', name: 'POMDP 规划', flagName: 'pomdpPlanner' },
      { version: '85.0', name: '符号求解', flagName: 'symbolicFeasibility' },
    ],
  },
  {
    index: 18,
    name: '执行层',
    kernels: [
      { version: '86.0', name: '分层技能', flagName: 'optionsFramework' },
      { version: '87.0', name: '安全屏障', flagName: 'safetyBarrier' },
      { version: '88.0', name: '离线评估', flagName: 'offPolicyEvaluation' },
      { version: '89.0', name: '安全策略改进', flagName: 'safePolicyImprovement' },
      { version: '90.0', name: '偏好学习', flagName: 'preferenceLearning' },
    ],
  },
  {
    index: 19,
    name: '进化层',
    kernels: [
      { version: '91.0', name: '新奇搜索', flagName: 'noveltySearch' },
      { version: '92.0', name: '自我对弈', flagName: 'selfPlay' },
      { version: '93.0', name: '自动机调优', flagName: 'automlHyperband' },
      { version: '94.0', name: '仿真校准', flagName: 'simulationCalibration' },
      { version: '95.0', name: '中断交接', flagName: 'interruptibleAutonomy' },
    ],
  },
  {
    index: 20,
    name: '意识层',
    kernels: [
      { version: '96.0', name: '全局工作空间', flagName: 'globalWorkspace' },
      { version: '97.0', name: '元认知信心', flagName: 'metacognitiveConfidence' },
      { version: '98.0', name: '经验重放', flagName: 'experienceReplay' },
      { version: '99.0', name: '注意力经济', flagName: 'attentionEconomy' },
      { version: '100.0', name: '自我边界', flagName: 'selfBoundary' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════
// 载荷构造器（纯函数——绑定口径可离线单测）
// ═══════════════════════════════════════════════════════════════════

/** 内核地图面板载荷（98 内核 × 20 层 + 旗标开关态合并） */
export interface KernelMapPayload {
  /** 内核总数（3.0→100.0 = 98） */
  total: number;
  /** 旗标内核数（51.0→100.0 = 50） */
  flagged: number;
  /** 开启旗标数 */
  enabled: number;
  /** 数据源说明（未注入 introspect 时为静态地图 + 缺省关） */
  note: string;
  layers: ReadonlyArray<{
    index: number;
    name: string;
    range: string;
    kernels: ReadonlyArray<{
      version: string;
      name: string;
      hasFlag: boolean;
      enabled: boolean;
      flagName?: string;
    }>;
  }>;
}

/**
 * 内核地图载荷构造（旗标绑定合并——绑定口径单测入口）。
 *
 * @param flagBindings introspect 旗标开关态（undefined / 缺名 = 该旗标缺省关）
 */
export function kernelMapPayload(flagBindings?: ReadonlyArray<KernelFlagBinding> | undefined): KernelMapPayload {
  const byName = new Map<string, boolean>();
  for (const f of flagBindings ?? []) byName.set(f.name, f.enabled === true);
  let flagged = 0;
  let enabled = 0;
  const layers = KERNEL_LAYER_MAP.map((layer) => {
    const kernels = layer.kernels.map((k) => {
      const hasFlag = k.flagName !== undefined;
      const on = hasFlag ? byName.get(k.flagName!) === true : false;
      if (hasFlag) {
        flagged += 1;
        if (on) enabled += 1;
      }
      return { version: k.version, name: k.name, hasFlag, enabled: on, flagName: k.flagName };
    });
    return {
      index: layer.index,
      name: layer.name,
      range: `${layer.kernels[0]!.version}–${layer.kernels[layer.kernels.length - 1]!.version}`,
      kernels,
    };
  });
  const total = layers.reduce((s, l) => s + l.kernels.length, 0);
  return {
    total,
    flagged,
    enabled,
    note:
      flagBindings === undefined
        ? '静态地图（introspect 旗标数据源未注入——旗标按缺省关显示）'
        : `旗标开关态来自 introspect 绑定（${enabled}/${flagged} 开）`,
    layers,
  };
}

/** GWT 意识总线面板载荷（最近广播流 / 点火率 / 胜者分布） */
export interface GwtBusPayload {
  available: boolean;
  steps: number;
  ignitionRatio: number;
  entropy: number;
  winCounts: ReadonlyArray<{ id: string; wins: number }>;
  /** 最近广播流（步序降序——最新在前） */
  broadcasts: ReadonlyArray<GwtBroadcastBinding>;
  /** 空态 / 常态说明 */
  emptyState: string;
}

/** GWT 总线载荷构造（undefined → 空态——面板显示「未挂载」提示） */
export function gwtBusPayload(view?: GwtBusBinding | undefined): GwtBusPayload {
  if (!view) {
    return {
      available: false,
      steps: 0,
      ignitionRatio: 0,
      entropy: 0,
      winCounts: [],
      broadcasts: [],
      emptyState: '意识总线未挂载或暂无数据——autonomyLoop.attachGlobalWorkspace 后心跳每拍投标仲裁',
    };
  }
  const broadcasts = [...view.recentBroadcasts].sort((a, b) => b.step - a.step);
  return {
    available: true,
    steps: view.steps,
    ignitionRatio: view.ignitionRatio,
    entropy: view.entropy,
    winCounts: [...view.winCounts],
    broadcasts,
    emptyState:
      broadcasts.length === 0
        ? '已挂载：尚无点火广播（投标均未超阈——总线安静）'
        : '',
  };
}

/** 注意力市场面板载荷（槽位分配 + VCG 支付，按源聚合） */
export interface AttentionMarketPayload {
  available: boolean;
  slots: number;
  awarded: number;
  marginalPrice: number;
  idleSlots: number;
  revenue: number;
  /** 逐槽胜出（按边际降序原文） */
  awards: ReadonlyArray<{ sourceId: string; slotNumber: number; marginal: number }>;
  /** 按源聚合：槽位数 / 累计边际 / VCG 支付（表格 + 条形数据源） */
  rows: ReadonlyArray<{ sourceId: string; slots: number; totalMarginal: number; payment: number }>;
  insight: string;
  emptyState: string;
}

/** 注意力市场载荷构造（undefined → 空态） */
export function attentionMarketPayload(view?: AttentionMarketBinding | undefined): AttentionMarketPayload {
  if (!view) {
    return {
      available: false,
      slots: 0,
      awarded: 0,
      marginalPrice: 0,
      idleSlots: 0,
      revenue: 0,
      awards: [],
      rows: [],
      insight: '',
      emptyState: '注意力拍卖未挂载或暂无数据——sentinel.attachAttentionEconomy 后信息流影子出清',
    };
  }
  const paymentBySource = new Map<string, number>();
  for (const p of view.payments) paymentBySource.set(p.sourceId, (paymentBySource.get(p.sourceId) ?? 0) + p.payment);
  const acc = new Map<string, { sourceId: string; slots: number; totalMarginal: number; payment: number }>();
  for (const a of view.awards) {
    const row = acc.get(a.sourceId) ?? { sourceId: a.sourceId, slots: 0, totalMarginal: 0, payment: 0 };
    row.slots += 1;
    row.totalMarginal += a.marginal;
    row.payment = paymentBySource.get(a.sourceId) ?? 0;
    acc.set(a.sourceId, row);
  }
  // 未获槽但被计支付的源也保留（完整账面）
  for (const [sourceId, payment] of paymentBySource) {
    if (!acc.has(sourceId)) acc.set(sourceId, { sourceId, slots: 0, totalMarginal: 0, payment });
  }
  const rows = [...acc.values()].sort((a, b) => b.totalMarginal - a.totalMarginal || a.sourceId.localeCompare(b.sourceId));
  return {
    available: true,
    slots: view.slots,
    awarded: view.awards.length,
    marginalPrice: view.marginalPrice,
    idleSlots: view.idleSlots,
    revenue: view.revenue,
    awards: [...view.awards],
    rows,
    insight: view.insight ?? '',
    emptyState: view.awards.length === 0 ? '已挂载：本拍无正边际胜出（注意力诚实闲置）' : '',
  };
}

// ═══════════════════════════════════════════════════════════════════
// 第四轮 R4-A15：实时告警统一视图（回归检测器 / 安全总督 / 元认知 KPI）
// ═══════════════════════════════════════════════════════════════════

/** 告警严重度（critical 红 / warning 黄 / info 蓝——分色口径） */
export type DashboardAlarmSeverity = 'critical' | 'warning' | 'info';

/**
 * 单条告警绑定（宿主注入的统一契约——三源共用一张脸）：
 * - source 'benchmark-regression'：基准 e-过程回归告警（benchmark-engine）；
 * - source 'safety-governor'：安全总督拦截 / 降级事件；
 * - source 'metacognition-kpi'：元认知 KPI 越限；
 * - 其他自定义 source 亦接受（前端按来源过滤 chip 动态渲染）。
 */
export interface DashboardAlarmBinding {
  /** 告警唯一 id（同 id 去重口径保留最新语义由宿主决定——载荷按时间排序） */
  id: string;
  /** 告警来源（如 'benchmark-regression' | 'safety-governor' | 'metacognition-kpi'） */
  source: string;
  severity: DashboardAlarmSeverity;
  /** 告警标题（一行结论） */
  title: string;
  /** 详情（读数 / 证据句；可缺省） */
  detail?: string;
  /** 告警时刻（ms epoch——注入时钟口径） */
  timestamp: number;
}

/** 告警流面板载荷（严重度分色统计 + 按时间倒序流 + 来源过滤） */
export interface AlarmFeedPayload {
  available: boolean;
  /** 过滤前告警总数 */
  total: number;
  /** 过滤后实际展示条数（≤ maxItems） */
  shown: number;
  /** 严重度分布（过滤前全量——顶部统计格数据源） */
  counts: { critical: number; warning: number; info: number };
  /** 来源分布（过滤前全量，计数降序 / 同数按名升序——过滤 chip 数据源） */
  sources: ReadonlyArray<{ source: string; count: number }>;
  /** 告警流（时间倒序；同刻按 id 升序——确定性；过滤后截断 maxItems） */
  alarms: ReadonlyArray<DashboardAlarmBinding>;
  /** 当前过滤来源（undefined = 不过滤） */
  filterSource: string | undefined;
  /** 空态 / 常态说明 */
  emptyState: string;
}

/**
 * 严重度归一（防御口径）：仅认 critical / warning，其余（含缺省、拼错、
 * 未知枚举）一律按 info——告警面永不因脏输入 500。
 */
export function classifyAlarmSeverity(severity: string | undefined): DashboardAlarmSeverity {
  return severity === 'critical' || severity === 'warning' ? severity : 'info';
}

/**
 * 告警流载荷构造（第四轮 R4-A15 主口径——纯函数，绑定口径单测入口）。
 *
 * - undefined → available:false 空态（数据源未注入，零漂移）；
 * - 排序：时间倒序（最新在前），同刻按 id 升序——注入时钟下完全确定；
 * - counts / sources 为过滤前全量口径（统计格与过滤 chip 不随过滤塌缩）；
 * - alarms 为过滤后（filterSource 命中才保留）再截断 maxItems（默认 50）；
 * - severity 经 classifyAlarmSeverity 归一（脏输入按 info，不抛错）。
 */
export function alarmFeedPayload(
  alarms?: ReadonlyArray<DashboardAlarmBinding> | undefined,
  options?: { filterSource?: string; maxItems?: number },
): AlarmFeedPayload {
  const maxItems = Math.max(1, Math.floor(options?.maxItems ?? 50));
  const filterSource = options?.filterSource;
  if (!alarms) {
    return {
      available: false,
      total: 0,
      shown: 0,
      counts: { critical: 0, warning: 0, info: 0 },
      sources: [],
      alarms: [],
      filterSource,
      emptyState: '告警源未注入——回归检测器 / 安全总督 / 元认知 KPI 统一视图待挂载（sources.getAlarms）',
    };
  }
  const normalized = alarms.map((a) => ({
    id: String(a?.id ?? ''),
    source: String(a?.source ?? 'unknown'),
    severity: classifyAlarmSeverity(a?.severity),
    title: String(a?.title ?? ''),
    detail: a?.detail,
    timestamp: Number.isFinite(a?.timestamp) ? a.timestamp : 0,
  }));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const a of normalized) counts[a.severity] += 1;
  const sourceCounts = new Map<string, number>();
  for (const a of normalized) sourceCounts.set(a.source, (sourceCounts.get(a.source) ?? 0) + 1);
  const sources = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const filtered =
    filterSource === undefined ? normalized : normalized.filter((a) => a.source === filterSource);
  const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  const alarmsOut = sorted.slice(0, maxItems);
  const emptyState =
    normalized.length === 0
      ? '暂无任何告警——基准回归 / 安全总督 / 元认知 KPI 三源安静'
      : filtered.length === 0
        ? `来源「${filterSource}」下暂无告警（全量 ${normalized.length} 条）——点击全部恢复`
        : '';
  return {
    available: true,
    total: normalized.length,
    shown: alarmsOut.length,
    counts,
    sources,
    alarms: alarmsOut,
    filterSource,
    emptyState,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 第四轮 R4-A15：仪表盘自定义布局持久化（纯函数 + localStorage 键契约）
// ═══════════════════════════════════════════════════════════════════

/** 布局偏好持久化键（localStorage——HTML 内嵌脚本与离线测试共用同键） */
export const DASHBOARD_LAYOUT_STORAGE_KEY = 'dsh-dashboard-layout-v1';

/**
 * 仪表盘面板默认序（id 与 HTML 面板容器 id 一一对应）：
 * 全局统计 / 实时事件流 / 执行计划 / 内核地图 / 意识总线 / 注意力市场 / 实时告警。
 */
export const DEFAULT_DASHBOARD_PANELS: ReadonlyArray<string> = [
  'overview-stats',
  'event-stream',
  'plan-feed',
  'kernel-map',
  'gwt-panel',
  'attention-panel',
  'alarm-panel',
];

/** 布局偏好（面板显隐 + 顺序——版本化，坏版本整体回退默认） */
export interface DashboardLayoutPrefs {
  version: 1;
  /** 隐藏面板 id 集（其余全部显示） */
  hidden: string[];
  /** 面板显示顺序（面板全集的一个排列） */
  order: string[];
}

/** 默认布局（全部显示、默认序） */
export function defaultDashboardLayout(): DashboardLayoutPrefs {
  return { version: 1, hidden: [], order: [...DEFAULT_DASHBOARD_PANELS] };
}

/**
 * 布局归一（防御口径——任何输入都产出合法偏好）：
 * - 未知面板 id 从 hidden / order 中过滤（版本升级后面板改名不残留僵尸）；
 * - 已知面板缺序 → 按默认序追加到 order 末尾（新面板自然可见）；
 * - hidden ⊆ order 全集；字段缺省 / 非数组按空处理。
 */
export function normalizeDashboardLayout(
  prefs: Partial<DashboardLayoutPrefs> | undefined | null,
  panels: ReadonlyArray<string> = DEFAULT_DASHBOARD_PANELS,
): DashboardLayoutPrefs {
  const known = [...panels];
  const hidden = Array.isArray(prefs?.hidden)
    ? [...new Set(prefs!.hidden.filter((id): id is string => typeof id === 'string' && known.includes(id)))]
    : [];
  const storedOrder = Array.isArray(prefs?.order)
    ? prefs!.order.filter((id): id is string => typeof id === 'string' && known.includes(id))
    : [];
  const order = [...storedOrder];
  for (const id of known) if (!order.includes(id)) order.push(id);
  return { version: 1, hidden, order };
}

/** 序列化（localStorage 写入口径——紧凑 JSON） */
export function serializeDashboardLayout(prefs: DashboardLayoutPrefs): string {
  return JSON.stringify({ version: 1, hidden: prefs.hidden, order: prefs.order });
}

/**
 * 反序列化（localStorage 读入口径——坏输入一律回退默认）：
 * JSON 解析失败 / 非对象 / 版本不是 1 / 字段形状不对 → defaultDashboardLayout()；
 * 形状对但含未知面板 / 缺面板 → normalizeDashboardLayout 修补（不整盘丢弃
 * 用户偏好——只清洗脏位）。序列化往返恒等：parse(serialize(normalize(p)))
 * ≡ normalize(p)。
 */
export function parseDashboardLayout(
  raw: string | null | undefined,
  panels: ReadonlyArray<string> = DEFAULT_DASHBOARD_PANELS,
): DashboardLayoutPrefs {
  if (typeof raw !== 'string' || raw.length === 0) return defaultDashboardLayout();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultDashboardLayout();
    const candidate = parsed as { version?: unknown; hidden?: unknown; order?: unknown };
    if (candidate.version !== 1) return defaultDashboardLayout();
    return normalizeDashboardLayout(
      {
        hidden: Array.isArray(candidate.hidden) ? candidate.hidden : [],
        order: Array.isArray(candidate.order) ? candidate.order : [],
      },
      panels,
    );
  } catch {
    return defaultDashboardLayout();
  }
}

/** 可见面板序列（order 中剔除 hidden——渲染口径） */
export function visibleOrderedPanels(
  prefs: DashboardLayoutPrefs,
  panels: ReadonlyArray<string> = DEFAULT_DASHBOARD_PANELS,
): ReadonlyArray<string> {
  const normalized = normalizeDashboardLayout(prefs, panels);
  return normalized.order.filter((id) => !normalized.hidden.includes(id));
}

// ═══════════════════════════════════════════════════════════════════
// 仪表盘挂载（HTTP 端点路由）
// ═══════════════════════════════════════════════════════════════════

/**
 * 将仪表盘挂载到进度广播器的 HTTP 端口
 * @param broadcaster 已创建的进度广播器（须在 start() 之前或之后调用均可）
 * @param getModelStatuses 模型状态提供函数（通常绑定 LLMClient.getModelStatuses）
 * @param sources 第三轮 A15 可选数据源（内核旗标 / 意识总线 / 注意力市场；
 *   未注入时对应端点返回空态——既有两参调用完全兼容，零漂移）
 * @returns 卸载函数（恢复默认健康检查响应）
 */
export function attachDashboard(
  broadcaster: ProgressBroadcaster,
  getModelStatuses: () => ModelRuntimeStatus[],
  sources?: DashboardExtraSources,
): () => void {
  const html = loadDashboardHtml();

  broadcaster.setHttpHandler((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return true;
    }

    if (req.method === 'GET' && url === '/api/model-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(getModelStatuses()));
      return true;
    }

    // ── 第三轮 A15：内核地图 / 意识总线 / 注意力市场（数据源未注入 → 空态）──
    if (req.method === 'GET' && url === '/api/kernel-map') {
      respondJson(res, () => kernelMapPayload(safeCall(sources?.getKernelFlags)));
      return true;
    }
    if (req.method === 'GET' && url === '/api/gwt-bus') {
      respondJson(res, () => gwtBusPayload(safeCall(sources?.getGwtBus)));
      return true;
    }
    if (req.method === 'GET' && url === '/api/attention-market') {
      respondJson(res, () => attentionMarketPayload(safeCall(sources?.getAttentionMarket)));
      return true;
    }

    // ── 第四轮 R4-A15：实时告警统一视图（?source= 按类型过滤；未注入 → 空态）──
    if (req.method === 'GET' && url === '/api/alarm-feed') {
      const filterSource = query.get('source') ?? undefined;
      respondJson(res, () =>
        alarmFeedPayload(safeCall(sources?.getAlarms), { filterSource: filterSource === '' ? undefined : filterSource }),
      );
      return true;
    }

    return false;
  });

  return () => broadcaster.setHttpHandler(null);
}

/** 数据源防御调用（抛错按「无数据」处理——面板空态降级，不拖垮端点） */
function safeCall<T>(provider?: () => T | undefined): T | undefined {
  if (!provider) return undefined;
  try {
    return provider();
  } catch {
    return undefined;
  }
}

/** JSON 响应（构造器抛错时返回 500——纯函数不应抛，防御口径） */
function respondJson(res: import('node:http').ServerResponse, build: () => unknown): void {
  try {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(build()));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

/** 读取仪表盘页面（优先 dist 打包路径，回退 src 源码路径） */
function loadDashboardHtml(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'index.html'),
    path.join(here, '..', '..', 'src', 'dashboard', 'index.html'),
    path.join(here, '..', 'src', 'dashboard', 'index.html'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return '<html><body><h1>dashboard 页面未找到</h1></body></html>';
}
