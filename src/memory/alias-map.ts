/**
 * alias-map.ts — 防幻觉短索引映射（自主学习建议 3）
 *
 * 将冗长的记忆 ID（指纹 / 策略 id / 教训 id）在注入大模型前转换为短索引（#1, #2, #3），
 * 模型只需引用短索引，输出后再反向解析回完整 ID：
 * - 降低模型复述长 ID 产生的幻觉率
 * - 减少注入与输出的 Token 消耗
 *
 * 映射为请求级临时对象（不持久化）：每次注入前新建，注入与反解共用同一实例。
 *
 * 第三轮升级：别名消歧（同名多实体按上下文共现消歧 + 分离度置信度）。
 * 同一个人类可读名称（label，如「python 服务」「部署脚本」）往往对应多个
 * 实体（不同租户 / 不同指纹 / 不同教训 id）；仅在注入时登记 label → 实体的
 * 一次映射无法处理「模型说 #3 时到底指哪个」。新增维度：
 * - registerEntity / observeContext：登记 label 下的候选实体并持续观察
 *   「该实体在什么上下文 token 旁出现过」（共现计数）
 * - disambiguate(label, contextTokens)：按上下文共现打分消歧——token 带逆实体频
 *   （IDF）权重（越少实体共有的 token 判别力越强），输出胜出实体 + 分离度置信度
 *   confidence = top/(top+second)（两候选同分时 0.5，压倒性优势趋近 1）
 * - 既有 encode/resolve/encodeText/decodeText 短索引语义逐位不变（零漂移）
 */

/** 消歧候选实体（带共现得分） */
export interface DisambiguationCandidate {
  id: string;
  /** 查询上下文与该实体历史共现的加权得分（> 0 表示有共现证据） */
  score: number;
}

/** 消歧结果：胜出实体 + 分离度置信度 + 全部候选（按得分降序） */
export interface DisambiguationResult {
  id: string;
  /**
   * 分离度置信度 = top/(top+second)：
   * - 1.0：唯一候选或次名得分为 0（上下文证据压倒性）
   * - 0.5：前两名同分（无法区分，调用方应追加上下文或询问用户）
   * - 次名得分趋近 0 时趋近 1（证据清晰）
   */
  confidence: number;
  candidates: DisambiguationCandidate[];
}

/** label 下的候选实体（共现计数累积） */
interface LabelEntity {
  id: string;
  /** token → 共现次数（该实体出现时旁侧上下文 token 的累积计数） */
  contextCounts: Map<string, number>;
  totalObservations: number;
}

export class AliasMap {
  private encodeMap = new Map<string, string>();
  private decodeMap = new Map<string, string>();
  private next = 1;

  // ── 第三轮：同名多实体消歧登记（label → 候选实体集，请求级临时对象） ──
  private labelEntities = new Map<string, Map<string, LabelEntity>>();

  /** 为完整 ID 分配短索引（幂等），返回形如 #1 */
  encode(id: string): string {
    let alias = this.encodeMap.get(id);
    if (!alias) {
      alias = `#${this.next}`;
      this.next += 1;
      this.encodeMap.set(id, alias);
      this.decodeMap.set(alias.slice(1), id);
    }
    return alias;
  }

  /** 短索引 → 完整 ID（未知索引返回 undefined） */
  resolve(alias: string): string | undefined {
    return this.decodeMap.get(alias.startsWith('#') ? alias.slice(1) : alias);
  }

  /** 将文本中的完整 ID 替换为短索引（按 ID 长度降序，避免前缀误替换） */
  encodeText(text: string): string {
    let out = text;
    for (const id of [...this.encodeMap.keys()].sort((a, b) => b.length - a.length)) {
      out = out.split(id).join(this.encodeMap.get(id)!);
    }
    return out;
  }

  /** 将文本中的短索引反向解析回完整 ID（未登记的索引原样保留） */
  decodeText(text: string): string {
    return text.replace(/#(\d+)/g, (match, n: string) => this.decodeMap.get(n) ?? match);
  }

  /** 当前映射条目（调试/日志） */
  entries(): Array<{ alias: string; id: string }> {
    return [...this.encodeMap.entries()].map(([id, alias]) => ({ alias, id }));
  }

  get size(): number {
    return this.encodeMap.size;
  }

  // ───────────────────── 第三轮升级：别名消歧（同名多实体） ─────────────────────

  /**
   * 登记一个「同名候选实体」：label 下出现的新实体 id（幂等）。
   *
   * 同一 label 可登记多个实体（同名多实体）；contextTokens 为该实体
   * 首次被观察到时的上下文（可为空——纯登记，等后续 observeContext 积累证据）。
   */
  registerEntity(id: string, label: string, contextTokens: string[] = []): void {
    let candidates = this.labelEntities.get(label);
    if (!candidates) {
      candidates = new Map();
      this.labelEntities.set(label, candidates);
    }
    let entity = candidates.get(id);
    if (!entity) {
      entity = { id, contextCounts: new Map(), totalObservations: 0 };
      candidates.set(id, entity);
    }
    this.absorbContext(entity, contextTokens);
  }

  /** 追加观察一次上下文共现（同一实体可多次观察，计数累积——证据越厚越稳） */
  observeContext(id: string, label: string, contextTokens: string[]): void {
    this.registerEntity(id, label, contextTokens);
  }

  /** 单次上下文吸收进实体共现计数 */
  private absorbContext(entity: LabelEntity, contextTokens: string[]): void {
    if (contextTokens.length === 0) return;
    entity.totalObservations += 1;
    for (const token of new Set(contextTokens.map((t) => t.toLowerCase()))) {
      if (!token) continue;
      entity.contextCounts.set(token, (entity.contextCounts.get(token) ?? 0) + 1);
    }
  }

  /**
   * 同名消歧：按上下文共现在 label 的候选实体中选出胜者。
   *
   * 打分：score(entity) = Σ_token count(entity, token) × idf(token)，
   * idf(token) = 1 / (1 + log(1 + 拥有该 token 的候选实体数))——
   * 全体候选共有的 token（无判别力）近乎不加权，独有 token 满权。
   *
   * @param label 同名标签（须先 registerEntity 至少一个候选）
   * @param contextTokens 当前查询上下文 token（任务描述/会话近邻词）
   * @returns 胜出实体 + 分离度置信度 + 候选全景；无候选 / 空上下文时 undefined
   */
  disambiguate(label: string, contextTokens: string[]): DisambiguationResult | undefined {
    const candidates = this.labelEntities.get(label);
    if (!candidates || candidates.size === 0) return undefined;
    const queryTokens = [...new Set(contextTokens.map((t) => t.toLowerCase()).filter(Boolean))];
    if (queryTokens.length === 0) return undefined;

    // token 的逆实体频（IDF）：拥有该 token 共现的候选实体越多，判别力越弱
    const holderCount = new Map<string, number>();
    for (const entity of candidates.values()) {
      for (const token of queryTokens) {
        if (entity.contextCounts.has(token)) holderCount.set(token, (holderCount.get(token) ?? 0) + 1);
      }
    }
    const idf = (token: string): number => 1 / (1 + Math.log(1 + (holderCount.get(token) ?? 0)));

    const scored: DisambiguationCandidate[] = [];
    for (const entity of candidates.values()) {
      let score = 0;
      for (const token of queryTokens) {
        const count = entity.contextCounts.get(token);
        if (count) score += count * idf(token);
      }
      scored.push({ id: entity.id, score: Number(score.toFixed(6)) });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

    const top = scored[0]!.score;
    const second = scored[1]?.score ?? 0;
    return {
      id: scored[0]!.id,
      confidence: top + second > 0 ? Number((top / (top + second)).toFixed(4)) : 0.5,
      candidates: scored,
    };
  }

  /** 消歧登记统计（调试/验证：同名标签数、其中歧义（≥2 候选）标签数、实体总数） */
  disambiguationStats(): { labels: number; ambiguousLabels: number; entities: number } {
    let ambiguousLabels = 0;
    let entities = 0;
    for (const candidates of this.labelEntities.values()) {
      if (candidates.size >= 2) ambiguousLabels += 1;
      entities += candidates.size;
    }
    return { labels: this.labelEntities.size, ambiguousLabels, entities };
  }
}
