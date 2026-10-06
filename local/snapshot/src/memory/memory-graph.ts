/**
 * memory-graph.ts — 记忆网络与主题树（自主学习建议 2：自定义数据结构序列化）
 *
 * SQLite 擅长行列存储，但图结构（记忆网络、主题树）是其短板。本组件将复杂关系
 * 保留在内存中管理与检索，定期序列化到本地 JSON 文件，Agent 启动时加载恢复：
 *
 * - 记忆网络：节点（任务模式 / 蒸馏策略 / 主题）+ 共现边（权重随共现次数增长），
 *   支撑"由一条记忆联想到相关记忆"的图检索（优化器混合检索的联想增强）
 * - 主题树：按 taskType 归类的层级结构（根主题 → 子主题 → 模式叶节点）
 *
 * 持久化：JSON 原子写（与记忆库同目录 memory-graph.json），dispose/flush 时落盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import { h0Persistence, topographyInsight, type TopographyReport } from '../core/persistent-homology.js';
import { pageRank, topInfluential, type PageRankResult } from '../core/spectral-ranking.js';
// 第四轮：跨任务迁移映射的保守评分口径（Wilson 95% 下界——小样本借用不虚高）
import { wilsonLowerBound } from '../core/evidence.js';

export interface MemoryNode {
  id: string;
  /**
   * 节点类型：
   * - pattern：任务模式（情景记忆叶节点）
   * - strategy：蒸馏策略（第一阶段既有）
   * - topic：主题树节点
   * - semantic：语义记忆节点（第二阶段，由知识蒸馏产出）
   * - procedural：程序记忆节点（第二阶段，由知识蒸馏产出）
   */
  kind: 'pattern' | 'strategy' | 'topic' | 'semantic' | 'procedural';
  label: string;
  createdAt: number;
}

export interface MemoryEdge {
  source: string;
  target: string;
  /** 共现次数 */
  cooccurrences: number;
  /** 归一化权重 0~1（cooccurrences / 5 封顶） */
  weight: number;
  lastAt: number;
}

export interface TopicNode {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  patternIds: string[];
}

/**
 * 图度统计报告（第三轮升级：供 69.0 Mapper 图内核消费的结构化导出）
 *
 * 共现网络的宏观形态读数：
 * - 度分布（degreeHistogram）：知识覆盖的偏态——多数节点低度 + 少数枢纽高度
 * - 连通分量（components）：知识大陆 vs 知识孤岛的数量级（与 H₀ 地形互补：
 *   地形回答「跨尺度持久」，度统计回答「度视角谁重要」）
 * - 中枢 Top-K（hubs）：归一化度 share = degree / (2E)，枢纽即共现网络的
 *   结构关键节点（与 PageRank 影响力口径互为印证）
 */
export interface GraphDegreeStats {
  nodes: number;
  edges: number;
  /** 平均度 = 2E/V（孤立节点计入分母） */
  avgDegree: number;
  /** 最大度（度最高的节点连接数） */
  maxDegree: number;
  /** 孤立节点数（度 0——尚未与任何记忆共现） */
  isolated: number;
  /** 度直方图（升序去空桶：degree → 拥有该度的节点数） */
  degreeHistogram: Array<{ degree: number; count: number }>;
  /** 连通分量（无向口径，并查集解出） */
  components: {
    /** 分量总数（含孤立节点自身的单点分量） */
    count: number;
    /** 最大分量的节点数 */
    largest: number;
    /** 单点分量数（= isolated） */
    singletons: number;
  };
  /** 中枢 Top-K（按度降序；share = degree / (2E)，E=0 时为 0） */
  hubs: Array<{ id: string; kind: MemoryNode['kind']; label: string; degree: number; share: number }>;
}

interface GraphFile {
  version: 1;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  topics: TopicNode[];
}

export class MemoryGraph {
  private nodes = new Map<string, MemoryNode>();
  private edges = new Map<string, MemoryEdge>();
  private topics = new Map<string, TopicNode>();
  private persistPath: string;
  /** 39.0：影响力排序（attachInfluenceRanking 后 related() 按 边权×邻居影响力 排序） */
  private influence?: PageRankResult;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.load();
  }

  /**
   * 无向边键：JSON 序列化排序对（第三轮修复：此前用 '::' 拼接 + split 还原，
   * 而记忆指纹自身含 '::'（如 deploy::0.5::k8s），端点会被切碎成 'deploy'/'0.5'，
   * related() 永远匹配不到邻居——JSON 转义保证任意字符的 id 无冲突）
   */
  private edgeKey(a: string, b: string): string {
    return JSON.stringify([a, b].sort());
  }

  /** 确保节点存在（幂等） */
  ensureNode(id: string, kind: MemoryNode['kind'], label: string): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, kind, label, createdAt: Date.now() });
    }
  }

  /** 记录共现：边权重随共现次数增长（上限 1） */
  link(a: string, b: string): MemoryEdge {
    const sorted = [a, b].sort();
    const key = this.edgeKey(a, b);
    let edge = this.edges.get(key);
    if (!edge) {
      edge = { source: sorted[0]!, target: sorted[1]!, cooccurrences: 0, weight: 0, lastAt: Date.now() };
      this.edges.set(key, edge);
    }
    edge.cooccurrences += 1;
    edge.weight = Math.min(1, edge.cooccurrences / 5);
    edge.lastAt = Date.now();
    return edge;
  }

  /** 图联想：按边权重返回相邻节点 id（混合检索的联想增强）
   *
   * 39.0：挂载影响力排序后，联想序从「边权」升维为「边权 × 邻居影响力」
   * （与枢纽共现的记忆先被想起）；未挂载时与原边权序逐位一致（零漂移）。
   */
  related(id: string, limit = 5): string[] {
    const neighbors: Array<{ id: string; weight: number }> = [];
    for (const edge of this.edges.values()) {
      if (edge.source === id) neighbors.push({ id: edge.target, weight: edge.weight });
      else if (edge.target === id) neighbors.push({ id: edge.source, weight: edge.weight });
    }
    if (this.influence) {
      const idx = new Map(this.influence.ids.map((nid, i) => [nid, i]));
      for (const n of neighbors) {
        const i = idx.get(n.id);
        n.weight *= i === undefined ? 1 : this.influence.scores[i] * this.influence.ids.length; // 归一化到均值 1
      }
    }
    return neighbors
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((n) => n.id);
  }

  /**
   * 39.0：挂载谱排序影响力（幂等覆盖，挂载即生效）。
   *
   * PageRank 幂迭代（阻尼 0.85，质量守恒 Σ=1）在共现网络上解出每条
   * 知识的结构影响力——「被重要者共现者重要」。topInfluential 输出
   * 知识骨架（蒸馏保骨去肉的依据）；related() 切换影响力加权口径。
   * 未挂载零漂移。
   */
  attachInfluenceRanking(options?: { damping?: number }): void {
    const ids = [...this.nodes.keys()];
    const idx = new Map(ids.map((id, i) => [id, i]));
    const weights = ids.map(() => ids.map(() => 0));
    for (const edge of this.edges.values()) {
      const i = idx.get(edge.source);
      const j = idx.get(edge.target);
      if (i === undefined || j === undefined) continue;
      weights[i][j] = edge.weight;
      weights[j][i] = edge.weight;
    }
    this.influence = pageRank(ids, weights, { damping: options?.damping });
  }

  /** 39.0：知识骨架清单（未挂载返回空数组） */
  topInfluential(k = 8): Array<{ id: string; score: number }> {
    return this.influence ? topInfluential(this.influence, k) : [];
  }

  /**
   * 36.0：知识地形（H₀ 持续同调；纯分析，无副作用）。
   *
   * 共现权重视为相似度、阈值从 1 向 floor 扫描：跨尺度持久的分量 =
   * 稳定知识大陆；永不合并的分量 = 知识孤岛（盲区的拓扑定义——
   * 与任何主题都不共现的记忆，正是好奇心该去的地方）。
   */
  knowledgeTopography(floor = 0.2): TopographyReport & { summary: string } {
    const report = h0Persistence([...this.nodes.keys()], [...this.edges.values()].map((e) => ({ source: e.source, target: e.target, weight: e.weight })), floor);
    return { ...report, summary: topographyInsight(report) };
  }

  /** 将模式挂到主题树（根主题 = taskType） */
  attachTopic(patternId: string, topicName: string, parentTopic?: string): TopicNode {
    let root = [...this.topics.values()].find((t) => t.name === topicName && t.parentId === null);
    if (!root) {
      root = { id: `topic:${topicName}`, name: topicName, parentId: null, childIds: [], patternIds: [] };
      this.topics.set(root.id, root);
    }
    if (parentTopic) {
      let parent = [...this.topics.values()].find((t) => t.name === parentTopic && t.parentId === null);
      if (parent && parent.id !== root.id && !parent.childIds.includes(root.id)) {
        parent.childIds.push(root.id);
        root.parentId = parent.id;
      }
    }
    if (!root.patternIds.includes(patternId)) root.patternIds.push(patternId);
    this.ensureNode(patternId, 'pattern', patternId);
    this.ensureNode(root.id, 'topic', topicName);
    return root;
  }

  /** 主题树（仅根节点，含子主题与叶模式） */
  topicTree(): TopicNode[] {
    return [...this.topics.values()].filter((t) => t.parentId === null);
  }

  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  stats(): { nodes: number; edges: number; topics: number } {
    return { nodes: this.nodes.size, edges: this.edges.size, topics: this.topics.size };
  }

  /**
   * 图度统计导出（第三轮升级：纯计算无副作用，供 69.0 Mapper 图内核消费）。
   *
   * 一次扫描解出：度序列 → 直方图/平均/最大/孤立数；并查集 → 连通分量
   * （总数/最大分量/单点分量）；度 Top-K → 中枢清单（归一化 share）。
   * @param topK 中枢清单长度，默认 8
   */
  degreeStats(topK = 8): GraphDegreeStats {
    const ids = [...this.nodes.keys()];
    const degree = new Map<string, number>(ids.map((id) => [id, 0]));
    // 并查集（路径压缩 + 按秩合并）
    const parent = new Map<string, string>(ids.map((id) => [id, id]));
    const rank = new Map<string, number>(ids.map((id) => [id, 0]));
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      while (parent.get(x) !== root) {
        const next = parent.get(x)!;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      if (rank.get(ra)! < rank.get(rb)!) {
        parent.set(ra, rb);
      } else if (rank.get(ra)! > rank.get(rb)!) {
        parent.set(rb, ra);
      } else {
        parent.set(rb, ra);
        rank.set(ra, rank.get(ra)! + 1);
      }
    };

    for (const edge of this.edges.values()) {
      if (!degree.has(edge.source) || !degree.has(edge.target)) continue; // 端点已删的悬挂边跳过
      degree.set(edge.source, degree.get(edge.source)! + 1);
      degree.set(edge.target, degree.get(edge.target)! + 1);
      union(edge.source, edge.target);
    }

    const histogramMap = new Map<number, number>();
    let isolated = 0;
    for (const d of degree.values()) {
      histogramMap.set(d, (histogramMap.get(d) ?? 0) + 1);
      if (d === 0) isolated += 1;
    }

    const componentSizes = new Map<string, number>();
    for (const id of ids) {
      const root = find(id);
      componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
    }
    const sizes = [...componentSizes.values()];

    const hubs = [...this.nodes.values()]
      .map((node) => ({ node, d: degree.get(node.id) ?? 0 }))
      .filter((h) => h.d > 0)
      .sort((a, b) => b.d - a.d || (a.node.id < b.node.id ? -1 : 1))
      .slice(0, Math.max(0, topK))
      .map(({ node, d }) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        degree: d,
        share: this.edges.size > 0 ? Number((d / (2 * this.edges.size)).toFixed(6)) : 0,
      }));

    return {
      nodes: ids.length,
      edges: this.edges.size,
      avgDegree: ids.length > 0 ? Number(((2 * this.edges.size) / ids.length).toFixed(4)) : 0,
      maxDegree: Math.max(0, ...degree.values()),
      isolated,
      degreeHistogram: [...histogramMap.entries()]
        .map(([deg, count]) => ({ degree: deg, count }))
        .sort((a, b) => a.degree - b.degree),
      components: {
        count: sizes.length,
        largest: sizes.length > 0 ? Math.max(...sizes) : 0,
        singletons: isolated,
      },
      hubs,
    };
  }

  /**
   * 邻接表视图（第三轮升级：Mapper 图内核的即接即用形状）。
   * 返回 id → 邻居 id 列表（纯结构口径：直接扫边，不受 attachInfluenceRanking
   * 挂载后的 related() 加权口径影响——Mapper 消费的是图的拓扑，不是排序）。
   */
  adjacency(): Array<{ id: string; neighbors: string[] }> {
    const table = new Map<string, string[]>([...this.nodes.keys()].map((id) => [id, []]));
    for (const edge of this.edges.values()) {
      table.get(edge.source)?.push(edge.target);
      table.get(edge.target)?.push(edge.source);
    }
    return [...table.entries()].map(([id, neighbors]) => ({ id, neighbors }));
  }

  /** 序列化到本地 JSON（原子写） */
  save(): void {
    const file: GraphFile = {
      version: 1,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      topics: [...this.topics.values()],
    };
    const dir = path.dirname(this.persistPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.persistPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file), 'utf-8');
    fs.renameSync(tmp, this.persistPath);
  }

  /** 启动时从本地 JSON 加载（损坏/缺失时从空图开始） */
  private load(): void {
    if (!fs.existsSync(this.persistPath)) return;
    try {
      const file = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as GraphFile;
      for (const node of file.nodes ?? []) this.nodes.set(node.id, node);
      for (const edge of file.edges ?? []) this.edges.set(this.edgeKey(edge.source, edge.target), edge);
      for (const topic of file.topics ?? []) this.topics.set(topic.id, topic);
    } catch {
      /* 损坏文件不阻塞启动 */
    }
  }
}

// ───────────────────── 第四轮升级（加分）：跨任务迁移映射 ─────────────────────
//
// 任务类型间的知识迁移表：A 类经验对 B 类任务的适用度，按历史借用成功率学习。
//
// 与「图联想」的分工：MemoryGraph 的边回答「哪两条记忆共现过」（记忆粒度），
// TransferMap 回答「哪两类任务的知识可以互相借用」（任务类型粒度）——
// B 类冷启动没有自己的经验时，迁移表指出该去借谁的成功经验：
// - recordBorrow：每次跨类型借用经验（借了 A 类的模式/策略去解 B 类任务）后
//   登记结果（成功/失败）——历史是唯一的老师
// - transferability：Wilson 95% 下界评分（10 借 9 成 ≈ 0.60，5 借 1 成 ≈ 0.04
//   ——小样本不虚高，与全库证据口径一致）；无借用史时回退结构相关度（注入
//   relatedness：如主题树同根/特征 Jaccard），并对折折扣（learned=false）
// - discoverTransferables：从全部借用史中发现「可迁移对」（已学习且分达标）
//
// 确定性：纯确定性登记/评分，无随机源；时钟由调用方注入（缺省 Date.now）。

/** 单个任务类型对的迁移适用度评分 */
export interface TransferScore {
  from: string;
  to: string;
  /** 是否已有足够借用历史（trials ≥ minTrials）支撑学习分 */
  learned: boolean;
  trials: number;
  successes: number;
  /** Wilson 95% 置信下界（learned 时的保守借用成功率） */
  wilsonLower: number;
  /** 结构相关度（0~1，构造时注入的 relatedness 回退口径） */
  heuristic: number;
  /** 综合适用度：learned ? wilsonLower : heuristic × 0.5（未学习打对折——诚实降级） */
  score: number;
}

/** 迁移映射配置 */
export interface TransferMapOptions {
  /** 判定「已学习」的最少借用次数（缺省 3） */
  minTrials?: number;
  /**
   * 结构相关度回退口径（0~1）：无借用史时按任务类型间的结构相似估分。
   * 如注入 (a, b) => 同根主题 0.8 / 特征 Jaccard …；缺省恒 0（无结构信息不给分）。
   */
  relatedness?: (a: string, b: string) => number;
}

/** 跨任务迁移映射（任务类型粒度的知识借用学习表） */
export class TransferMap {
  private borrows = new Map<string, { from: string; to: string; successes: number; trials: number; lastAt: number }>();
  private options: Required<Pick<TransferMapOptions, 'minTrials'>> & Pick<TransferMapOptions, 'relatedness'>;

  constructor(options?: TransferMapOptions) {
    this.options = { minTrials: options?.minTrials ?? 3, relatedness: options?.relatedness };
  }

  /** 有向对键（迁移有方向：A→B 可迁移不代表 B→A 可迁移） */
  private keyOf(from: string, to: string): string {
    return JSON.stringify([from, to]);
  }

  /**
   * 登记一次跨类型借用结果。
   * @param from 经验来源任务类型
   * @param to 借用方任务类型
   * @param success 借用后该次任务是否成功
   * @param at 借用发生时刻（缺省 Date.now；确定性验证请显式注入）
   */
  recordBorrow(from: string, to: string, success: boolean, at?: number): void {
    const key = this.keyOf(from, to);
    let record = this.borrows.get(key);
    if (!record) {
      record = { from, to, successes: 0, trials: 0, lastAt: 0 };
      this.borrows.set(key, record);
    }
    record.trials += 1;
    if (success) record.successes += 1;
    record.lastAt = at ?? Date.now();
  }

  /** 单对迁移适用度（学习分优先，无史回退结构相关度对折） */
  transferability(from: string, to: string): TransferScore {
    const record = this.borrows.get(this.keyOf(from, to));
    const trials = record?.trials ?? 0;
    const successes = record?.successes ?? 0;
    const learned = trials >= this.options.minTrials;
    const wilsonLower = learned ? wilsonLowerBound(successes, trials - successes) : 0;
    const heuristic = learned ? 0 : Math.max(0, Math.min(1, this.options.relatedness?.(from, to) ?? 0));
    return {
      from,
      to,
      learned,
      trials,
      successes,
      wilsonLower: Number(wilsonLower.toFixed(6)),
      heuristic: Number(heuristic.toFixed(6)),
      score: Number((learned ? wilsonLower : heuristic * 0.5).toFixed(6)),
    };
  }

  /** 全部出现过借用往来的任务类型（去重排序——确定性） */
  knownTypes(): string[] {
    const types = new Set<string>();
    for (const record of this.borrows.values()) {
      types.add(record.from);
      types.add(record.to);
    }
    return [...types].sort();
  }

  /**
   * 迁移去向建议：from 类经验的候选去向按适用度降序（经验不足 minTrials 的
   * 对也列出但 learned=false——调用方自行决定是否采信对折回退分）。
   */
  suggestTransfers(from: string, limit = 5): TransferScore[] {
    const targets = new Set<string>();
    for (const record of this.borrows.values()) {
      if (record.from === from) targets.add(record.to);
    }
    return [...targets]
      .map((to) => this.transferability(from, to))
      .sort((a, b) => b.score - a.score || (a.to < b.to ? -1 : 1))
      .slice(0, Math.max(0, limit));
  }

  /**
   * 可迁移对发现：从全部借用史中挑出「已学习且适用度 ≥ minScore」的方向对。
   * @param minScore 适用度门槛（缺省 0.55——10 借 9 成的 Wilson 下界 0.596 稳过线，
   *                 5 借 1 成的 0.036 远被排除）
   */
  discoverTransferables(minScore = 0.55): Array<{ from: string; to: string; score: number; successes: number; trials: number }> {
    const pairs: Array<{ from: string; to: string; score: number; successes: number; trials: number }> = [];
    for (const record of this.borrows.values()) {
      const score = this.transferability(record.from, record.to);
      if (score.learned && score.score >= minScore) {
        pairs.push({ from: record.from, to: record.to, score: score.score, successes: record.successes, trials: record.trials });
      }
    }
    return pairs.sort((a, b) => b.score - a.score || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));
  }

  /** 登记统计（借用总次数 / 方向对数 / 其中已学习对数） */
  stats(): { borrows: number; pairs: number; learnedPairs: number } {
    let borrows = 0;
    let learnedPairs = 0;
    for (const record of this.borrows.values()) {
      borrows += record.trials;
      if (record.trials >= this.options.minTrials) learnedPairs += 1;
    }
    return { borrows, pairs: this.borrows.size, learnedPairs };
  }
}
