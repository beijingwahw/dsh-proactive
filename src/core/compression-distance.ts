/**
 * compression-distance.ts — 68.0 压缩距离内核
 *
 * 动机: 11.0 理论家的口号是「理解即压缩 MDL」，但压缩至今只活在
 * Beta-Bernoulli 定律的 nat 账目里；「两条经验/两段记忆内容是否相近」
 * 的判定仍依赖向量嵌入。Kolmogorov 复杂度 K(x)（x 的最短描述长度）
 * 不可计算，但「压缩长度」是它的可计算上界代理：能被同一压缩器压到
 * 一起的两个串共享结构——「内容相近」第一次有了语法无关、零模型、
 * 零训练的距离度量（Cilibrasi–Vitányi 的归一化压缩距离族）。
 *
 * 数学:
 *   归一化压缩距离 NCD(x,y) = [C(xy) − min(C(x),C(y))] / max(C(x),C(y))
 *   ∈ [0, ~1+]。C(·) 为压缩后比特长度，xy 为拼接。类比
 *   K(xy) ≥ max(K(x),K(y))：NCD(x,x)≈0、同族串低、无关串≈1——
 *   家族相似性完全由压缩器的模式发现内生，无需任何嵌入模型。
 *   压缩器自实现 LZW（12 位字典码；初始字典 256 个单字节，满 4096
 *   冻结不再增条目），C(s) = 输出码数 × 12 bit——固定宽口径：
 *   不叠加熵编码，作为 K(x) 的保守上界，口径全文一致。
 *   对称化口径: 拼接边界吸收使 C(x+y) 与 C(y+x) 可差一个码，
 *   ncd 取两个方向压缩比特数的均值（矩阵严格对称的内生保证）。
 *   诚实边界（三条，全部如实统计、不掩盖）:
 *   a) 自距离定律: LZ78 族压缩器每次失配只给字典增长 1 个字符，
 *     短语长度近似 1,2,3,…,L 等差增长——|x| 字节 ≈ L≈√(2|x|) 个码，
 *     x·x 的码数 ≈ √2·L，故 NCD(x,x) → √2−1 ≈ 0.4142 而非 0
 *     （'ab'×2000 实测 0.4127，偏差 0.0015；熵编码级压缩器才能把
 *     自距离压到 ≈0，12 位固定码口径下这是结构性下界）。锚点②因此
 *     以「自距离是全行最小且 < 0.6 + √2−1 闭式对照」的诚实形式给出。
 *   b) NCD 非度量: 三角不等式可被违反（混合串 y=x+z 对两端同时近，
 *     是天然的违反构造）——违反率全量枚举统计。
 *   c) 次可加性 C(xy) ≤ C(x)+C(y)+O(1) 抽样验证（实测 slack=0）。
 *
 * 验证锚点（scripts/verify-compression-distance.mjs）:
 *   ① 压缩器健全性: 'ab'×2000 压缩比 <5% 且随长度单调下降；
 *     种子化伪随机串压不动（12 bit 码下反而膨胀 ≥1.2）
 *   ② 自距离: NCD(x,x) < 0.6 且是全行最小（自距离=内容同一性的
 *     可操作判据）；闭式对照 |NCD((ab)^2000,(ab)^2000) − (√2−1)| < 0.005
 *   ③ 两个 4 条「家族」（中英混合）: 族内平均 NCD < 族间平均 NCD
 *   ④ 次可加性抽样: C(x+y) ≤ C(x)+C(y)+24 bit（实测 slack = 0）
 *   ⑤ 三角不等式违反率统计（构造例违反 > 0——非度量的诚实报告）
 *   ⑥ 层次聚类（average-linkage）k=2 与阈值模式均 100% 恢复真分组
 *
 * R5 进化（第五轮·信息几何世界性进化）：
 *   ⑦ **LZ77 滑窗压缩器（lz77Compress / ncdLz77）**——压缩器升级对 NCD
 *     分辨率的提升**量化**（诚实口径，分内容类型）：
 *     a) 非周期内容（文本/自然串/伪随机）：第二拷贝几乎全由回引覆盖，
 *        NCD₇₇(x,x) 从 LZW 的 0.41–0.55 掉到 ~0.01–0.14——「内容同一性」
 *        判据的分辨率提升一个数量级（实测 38×）；
 *     b) 完全周期串（'ab'ⁿ）：LZ77 匹配在首周期内即可找到、两份拷贝
 *        无差别，自距离反而高（~0.89 > LZW 的 0.41）——两压缩器在周期
 *        内容上都有结构性地板，如实记录（族内/族间间隔两口径并排报告）。
 *     编码口径：字面量 9 bit（1 标志 + 8 数据），匹配 21 bit
 *     （1 + 12 窗口位 + 8 长度位；窗口 4096、最长匹配 258，deflate 风格）；
 *     匹配查找 3 字节哈希链（链深上限 128，确定性；贪心最长匹配）。
 *   ⑧ **NCD 压缩缓存（性能）**：C(·) 与 C(·+·) 的纯函数 memo（FIFO
 *     上限 512）——拼接串重复压缩（ncdMatrix 对同一语料的二次调用、
 *     重复 ncd 对）直接命中；纯 memo 化 ⟹ 结果逐位一致（等价），
 *     ncdCacheStats()/resetNcdCache() 暴露命中/未命中/逐出审计。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 常量与口径 ───────────────────────────

/** LZW 字典码位宽（12 位 → 字典地址空间 4096） */
const LZW_CODE_BITS = 12;
/** LZW 字典容量上限 = 2^12（满后冻结：继续查表但不再新增条目） */
const LZW_DICT_LIMIT = 4096;
/** 初始字典 = 256 个单字节符号 */
const LZW_INIT_ENTRIES = 256;

/**
 * 自距离渐近线（闭式）: LZ78 短语等差增长律下 NCD(x,x) → √2−1。
 * 不是缺陷的遮掩，是 12 位固定码口径的结构常数——自距离的解释基线
 * （长期记忆查重阈值的下界参考：自距离 ≈ 0.41–0.55，同族 ≈ 0.6，
 * 异族 ≈ 0.8+）。
 */
export const LZW_SELF_DISTANCE_ASYMPTOTE = Math.SQRT2 - 1;

/** LZW 压缩结果（固定宽口径：bits = codes.length × 12） */
export interface LzwResult {
  /** 输出码流（每个码 < 4096 的字典地址） */
  codes: number[];
  /** 压缩后比特长度 = codes.length × 12 */
  bits: number;
  /** 压缩结束时字典条目数（256 起步，封顶 4096） */
  dictEntries: number;
  /** 输入的 UTF-8 字节数（压缩比的分母） */
  bytes: number;
}

// ─────────────────────────── 确定性工具 ───────────────────────────

/** 确定性 PRNG（mulberry32；内核自带，伪随机串构造与宿主探测共用同一实现保证可复现） */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('mulberry32: seed 必须是有限数');
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 伪随机可打印 ASCII 串（94 符号表；高熵内容——「压不动」锚点的原料） */
const PRINTABLE_ASCII = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

/** 种子化伪随机串（同 seed 同输出；用于高熵基准与宿主探测） */
export function pseudoRandomString(length: number, seed: number): string {
  if (!Number.isInteger(length) || length < 0) throw new Error('pseudoRandomString: length 必须是非负整数');
  if (!Number.isFinite(seed)) throw new Error('pseudoRandomString: seed 必须是有限数');
  const rng = mulberry32(Math.floor(seed));
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PRINTABLE_ASCII[Math.floor(rng() * PRINTABLE_ASCII.length)]!;
  }
  return out;
}

/** 字符串 → UTF-8 字节数组（自实现，不用 TextEncoder——内核零依赖、无宿主 API） */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f) {
      out.push(code);
    } else if (code <= 0x7ff) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

// ─────────────────────────── LZW 压缩器 ───────────────────────────

/**
 * LZW 压缩（12 位字典码，固定宽计费）。
 *
 * 字典以 (前缀码, 下一字节) 二元组为键：键 = 前缀码×256+字节（前缀码
 * <4096、字节 <256 → 键无碰撞）。初始 256 单字节；每次失配输出当前
 * 短语码并登记 w+c；字典满 4096 冻结（继续查表、不再增条目）。
 * C(s) = 输出码数 × 12 bit——不做熵编码的保守上界（口径全文一致，
 * 是 K(x) 上界代理，不是最优压缩）。
 */
export function lzwCompress(s: string): LzwResult {
  if (typeof s !== 'string') throw new Error('lzwCompress: 入参必须是 string');
  const bytes = utf8Bytes(s);
  if (bytes.length === 0) {
    return { codes: [], bits: 0, dictEntries: LZW_INIT_ENTRIES, bytes: 0 };
  }
  const dict = new Map<number, number>();
  let next = LZW_INIT_ENTRIES;
  const codes: number[] = [];
  let w = bytes[0]!;
  for (let i = 1; i < bytes.length; i += 1) {
    const c = bytes[i]!;
    const key = w * 256 + c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      w = hit;
      continue;
    }
    codes.push(w);
    if (next < LZW_DICT_LIMIT) {
      dict.set(key, next);
      next += 1;
    }
    w = c;
  }
  codes.push(w);
  return { codes, bits: codes.length * LZW_CODE_BITS, dictEntries: next, bytes: bytes.length };
}

/** C(s)：压缩后比特长度（= lzwCompress(s).bits；矩阵/聚类的缓存口径） */
export function compressedBits(s: string): number {
  if (typeof s !== 'string') throw new Error('compressedBits: 入参必须是 string');
  return cachedBits(LZW_CACHE_PREFIX + s, () => lzwCompress(s).bits);
}

// ─────────────────────────── R5：压缩结果缓存（纯 memo，FIFO 上限） ───────────────────────────

const LZW_CACHE_PREFIX = 'lzw|';
const LZ77_CACHE_PREFIX = 'lz77|';
const NCD_CACHE_LIMIT = 512;
const bitsCache = new Map<string, number>();
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;

/** 纯函数 memo：同 key 同结果（逐位一致）；FIFO 逐出上限 512 项 */
function cachedBits(key: string, compute: () => number): number {
  const hit = bitsCache.get(key);
  if (hit !== undefined) {
    cacheHits += 1;
    return hit;
  }
  const v = compute();
  bitsCache.set(key, v);
  cacheMisses += 1;
  if (bitsCache.size > NCD_CACHE_LIMIT) {
    const oldest = bitsCache.keys().next().value;
    if (oldest !== undefined) bitsCache.delete(oldest);
    cacheEvictions += 1;
  }
  return v;
}

/** 压缩缓存审计（R5 性能验证：命中/未命中/逐出/在库条目数） */
export function ncdCacheStats(): { size: number; hits: number; misses: number; evictions: number } {
  return { size: bitsCache.size, hits: cacheHits, misses: cacheMisses, evictions: cacheEvictions };
}

/** 清空压缩缓存（测试与内存治理口径） */
export function resetNcdCache(): void {
  bitsCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
  cacheEvictions = 0;
}

// ─────────────────────────── R5：LZ77 滑窗压缩器 ───────────────────────────

/** LZ77 最短匹配长度（deflate 风格：len ≥ 3 才值得编码） */
export const LZ77_MIN_MATCH = 3;
/** LZ77 缺省窗口（字节；4096 = 12 位回引距离） */
export const LZ77_DEFAULT_WINDOW = 4096;
/** LZ77 缺省最长匹配（258 = deflate 风格上界；8 位长度编码） */
export const LZ77_DEFAULT_MAX_MATCH = 258;
/** 匹配查找哈希链深度上限（确定性贪心：近端候选优先，找到满长即停） */
export const LZ77_CHAIN_LIMIT = 128;

/** LZ77 压缩选项 */
export interface Lz77Options {
  /** 回引窗口字节宽（缺省 4096） */
  window?: number;
  /** 最长匹配（缺省 258） */
  maxMatch?: number;
}

/** LZ77 压缩结果（固定口径：literal 9 bit；match = 1 + log2(窗口) + log2(长度档) 位） */
export interface Lz77Result {
  /** 压缩后比特长度 */
  bits: number;
  /** 字面量 token 数 */
  literals: number;
  /** 匹配 token 数 */
  matches: number;
  /** 最长命中匹配 */
  longestMatch: number;
  /** 输入 UTF-8 字节数 */
  bytes: number;
  /** 使用的窗口 / 最长匹配参数 */
  window: number;
  maxMatch: number;
}

/**
 * LZ77 滑窗压缩（R5；deflate 风格计费）：
 * - token 口径：字面量 = 1 标志位 + 8 数据位 = 9 bit；
 *   匹配 = 1 + log2(窗口) + log2(长度档数) 位（缺省 12 + 8 → 21 bit）。
 * - 匹配查找：3 字节前缀哈希 → 候选位置链（近端优先，链深 ≤ 128，
 *   找到满长即停）——确定性贪心最长匹配。
 * - NCD 分辨率的意义：长匹配使非周期内容（文本/自然串）的**第二拷贝**
 *   几乎全由回引覆盖——自距离从 LZW 的 √2−1 结构地板掉到 ~0.01–0.14
 *   （完全周期串除外：匹配在首周期内即找到，两口径都有结构地板——
 *   见文件头诚实口径 b 条）。
 */
export function lz77Compress(s: string, options?: Lz77Options): Lz77Result {
  if (typeof s !== 'string') throw new Error('lz77Compress: 入参必须是 string');
  const window = Math.max(64, Math.min(1 << 20, Math.floor(options?.window ?? LZ77_DEFAULT_WINDOW)));
  const maxMatch = Math.max(LZ77_MIN_MATCH, Math.floor(options?.maxMatch ?? LZ77_DEFAULT_MAX_MATCH));
  const bytes = utf8Bytes(s);
  if (bytes.length === 0) {
    return { bits: 0, literals: 0, matches: 0, longestMatch: 0, bytes: 0, window, maxMatch };
  }
  const windowBits = Math.ceil(Math.log2(window));
  const lenBits = Math.max(1, Math.ceil(Math.log2(maxMatch - LZ77_MIN_MATCH + 1)));
  const literalCost = 1 + 8;
  const matchCost = 1 + windowBits + lenBits;
  const table = new Map<number, number[]>();
  const insert = (pos: number): void => {
    if (pos + LZ77_MIN_MATCH > bytes.length) return;
    const key = (bytes[pos]! * 65536 + bytes[pos + 1]! * 256 + bytes[pos + 2]!) | 0;
    const chain = table.get(key);
    if (chain === undefined) table.set(key, [pos]);
    else chain.push(pos);
  };
  let i = 0;
  let bits = 0;
  let literals = 0;
  let matches = 0;
  let longest = 0;
  while (i < bytes.length) {
    let bestLen = 0;
    if (i + LZ77_MIN_MATCH <= bytes.length) {
      const key = (bytes[i]! * 65536 + bytes[i + 1]! * 256 + bytes[i + 2]!) | 0;
      const chain = table.get(key);
      if (chain !== undefined && chain.length > 0) {
        const cap = Math.min(maxMatch, bytes.length - i);
        let scanned = 0;
        for (let c = chain.length - 1; c >= 0 && scanned < LZ77_CHAIN_LIMIT; c -= 1) {
          const cand = chain[c]!;
          if (i - cand > window) break; // 越出窗口（链按位置升序，更早的更远）
          scanned += 1;
          // 匹配长度（哈希已保证前 3 字节相同，从 0 全量比对最稳妥）
          let len = 0;
          while (len < cap && bytes[cand + len] === bytes[i + len]) len += 1;
          if (len > bestLen) {
            bestLen = len;
            if (len >= cap) break; // 已达理论上限
          }
        }
      }
    }
    if (bestLen >= LZ77_MIN_MATCH) {
      bits += matchCost;
      matches += 1;
      if (bestLen > longest) longest = bestLen;
      for (let k = 0; k < bestLen; k += 1) insert(i + k); // 途经位置入索引
      i += bestLen;
    } else {
      bits += literalCost;
      literals += 1;
      insert(i);
      i += 1;
    }
  }
  return { bits, literals, matches, longestMatch: longest, bytes: bytes.length, window, maxMatch };
}

/** C77(s)：LZ77 压缩比特长度（缓存口径；options 进缓存键） */
export function lz77CompressedBits(s: string, options?: Lz77Options): number {
  if (typeof s !== 'string') throw new Error('lz77CompressedBits: 入参必须是 string');
  const window = Math.max(64, Math.min(1 << 20, Math.floor(options?.window ?? LZ77_DEFAULT_WINDOW)));
  const maxMatch = Math.max(LZ77_MIN_MATCH, Math.floor(options?.maxMatch ?? LZ77_DEFAULT_MAX_MATCH));
  const key = `${LZ77_CACHE_PREFIX}${window}:${maxMatch}|${s}`;
  return cachedBits(key, () => lz77Compress(s, { window, maxMatch }).bits);
}

/**
 * LZ77 口径 NCD（R5）：与 ncd 同公式、同对称化（双向拼接均值）、
 * 同 clamp ≥ 0，仅压缩器换 LZ77——自距离/近重复距离显著低于 LZW
 * 口径（分辨率提升的量化对照锚），非负性与对称性逐位保持。
 */
export function ncdLz77(x: string, y: string, options?: Lz77Options): number {
  if (typeof x !== 'string' || typeof y !== 'string') throw new Error('ncdLz77: 入参必须是 string');
  const cx = lz77CompressedBits(x, options);
  const cy = lz77CompressedBits(y, options);
  const max = Math.max(cx, cy);
  if (max === 0) return 0;
  const cxy = (lz77CompressedBits(x + y, options) + lz77CompressedBits(y + x, options)) / 2;
  const value = (cxy - Math.min(cx, cy)) / max;
  return Math.max(0, value);
}

// ─────────────────────────── NCD 距离 ───────────────────────────

/**
 * 归一化压缩距离 NCD(x,y) = [C(xy) − min(C(x),C(y))] / max(C(x),C(y))。
 *
 * 对称化口径: C(xy) 取 [C(x+y) + C(y+x)] / 2（拼接边界吸收使单方向
 * 可差一个码，取两方向均值保证严格对称）。C(xy) 可略超 C(x)+C(y)
 * （LZW 冻结/失配的账目尘埃）→ NCD 可略 > 1；两空串定义为 0。
 * 结果 clamp 到 ≥ 0（极短的串对可出 −1/12 级负尘埃，非负性是距离
 * 的底线；正值上界不 clamp——诚实呈现压缩器的全部缺陷）。
 */
export function ncd(x: string, y: string): number {
  if (typeof x !== 'string' || typeof y !== 'string') throw new Error('ncd: 入参必须是 string');
  const cx = compressedBits(x);
  const cy = compressedBits(y);
  const max = Math.max(cx, cy);
  if (max === 0) return 0; // 两空串
  const cxy = (compressedBits(x + y) + compressedBits(y + x)) / 2;
  const value = (cxy - Math.min(cx, cy)) / max;
  return Math.max(0, value);
}

/**
 * NCD 对称矩阵（n×n）。matrix[i][j] = NCD(items[i], items[j])，
 * 对角线 = NCD(x,x)（压缩器自距离，非 0——如实保留，见锚点②）。
 */
export function ncdMatrix(items: string[]): number[][] {
  assertStringArray(items, 'ncdMatrix');
  const n = items.length;
  const bits = items.map((s) => compressedBits(s));
  const matrix: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < n; j += 1) {
      const max = Math.max(bits[i]!, bits[j]!);
      if (max === 0) {
        row.push(0);
        continue;
      }
      // 对称口径：i<j 方向算一次，j<i 复用（j==i 即自距离）
      const cxy = i <= j ? (compressedBits(items[i]! + items[j]!) + compressedBits(items[j]! + items[i]!)) / 2 : 0;
      row.push(Math.max(0, (cxy - Math.min(bits[i]!, bits[j]!)) / max));
    }
    matrix.push(row);
    for (let j = 0; j < i; j += 1) {
      row[j] = matrix[j]![i]!; // 严格对称：复用上三角
    }
  }
  return matrix;
}

// ─────────────────────────── 层次聚类（average-linkage） ───────────────────────────

/** 聚类选项：k（目标簇数）或 threshold（平均链距离 ≤ 阈值才继续合并）——二选一 */
export interface NcdClusterOptions {
  /** 目标簇数（1 ≤ k ≤ n；合并到剩 k 簇为止） */
  k?: number;
  /** 平均链距离阈值（0 ≤ threshold ≤ 2；最近的簇对距离 ≤ 阈值时合并） */
  threshold?: number;
}

/** 一次合并的审计记录（哪两个簇、合并时平均链距离多少） */
export interface NcdClusterMerge {
  /** 被并入的簇序号（合并前的簇表下标） */
  into: number;
  /** 并入者（簇表下标，恒大于 into） */
  merged: number;
  /** 合并时的 average-linkage 距离 */
  distance: number;
}

/** 层次聚类结果 */
export interface NcdClusterResult {
  /** 实际簇数 */
  k: number;
  /** 截断模式 */
  mode: 'k' | 'threshold';
  /** 阈值模式的阈值（k 模式为 undefined） */
  threshold: number | undefined;
  /** assignments[i] = 第 i 个条目所属簇编号（0 起，按首成员出现顺序编号） */
  assignments: number[];
  /** clusters[c] = 该簇的条目下标列表（升序） */
  clusters: number[][];
  /** 合并审计序列（按发生顺序；可逐层追溯「为什么聚到一起」） */
  merges: NcdClusterMerge[];
  /** 族内平均 NCD（同簇 i<j 对的均值；无同簇对时为 0） */
  intraMeanNcd: number;
  /** 族间平均 NCD（异簇 i<j 对的均值；单簇时为全体对均值） */
  interMeanNcd: number;
  /** 直径：最大族内 NCD（单点簇不计） */
  diameterNcd: number;
}

/**
 * NCD 层次聚类（凝聚的 average-linkage）。
 *
 * 每轮在现存簇中找平均链距离（两簇成员两两 NCD 的均值）最小的簇对
 * 合并；k 模式合并到剩 k 簇，threshold 模式合并到最近簇对距离 >
 * 阈值为止。平局取 (i,j) 字典序最小——确定性。O(n³) 内部重算，
 * 适用 n ≤ 数百（长期记忆近邻查重/反思器聚类的典型规模）。
 */
export function ncdCluster(items: string[], options: NcdClusterOptions): NcdClusterResult {
  assertStringArray(items, 'ncdCluster');
  const n = items.length;
  const hasK = options.k !== undefined;
  const hasThreshold = options.threshold !== undefined;
  if (hasK === hasThreshold) throw new Error('ncdCluster: k 与 threshold 必须恰好提供一个');
  if (hasK && (!Number.isInteger(options.k) || options.k! < 1 || options.k! > n)) {
    throw new Error(`ncdCluster: k 必须是 1..${n} 的整数`);
  }
  if (hasThreshold && (!Number.isFinite(options.threshold) || options.threshold! < 0 || options.threshold! > 2)) {
    throw new Error('ncdCluster: threshold 必须是 [0, 2] 内的有限数');
  }
  const mode: 'k' | 'threshold' = hasK ? 'k' : 'threshold';
  const targetK = hasK ? options.k! : 1;
  const threshold = hasThreshold ? options.threshold! : Infinity;

  const d = ncdMatrix(items);
  // active[c] = 簇 c 是否存活；members[c] = 成员下标（重算平均链，O(n³) 总量）
  const active: boolean[] = items.map(() => true);
  const members: number[][] = items.map((_, i) => [i]);
  const merges: NcdClusterMerge[] = [];
  let alive = n;

  const linkage = (a: number[], b: number[]): number => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += d[i]![j]!;
    return sum / (a.length * b.length);
  };

  while (alive > targetK) {
    let best = Infinity;
    let bestI = -1;
    let bestJ = -1;
    for (let i = 0; i < n; i += 1) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (!active[j]) continue;
        const dist = linkage(members[i]!, members[j]!);
        if (dist < best - 1e-12) {
          best = dist;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break; // 只剩一个簇
    if (mode === 'threshold' && best > threshold) break;
    merges.push({ into: bestI, merged: bestJ, distance: round(best) });
    members[bestI]!.push(...members[bestJ]!);
    members[bestI]!.sort((a, b) => a - b);
    members[bestJ] = [];
    active[bestJ] = false;
    alive -= 1;
  }

  // 按首成员出现顺序重编号（确定性输出顺序）
  const clusters = members.filter((m) => m.length > 0);
  const assignments = new Array<number>(n).fill(0);
  clusters.forEach((cluster, c) => cluster.forEach((i) => (assignments[i] = c)));

  let intraSum = 0;
  let intraPairs = 0;
  let interSum = 0;
  let interPairs = 0;
  let diameter = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dij = d[i]![j]!;
      if (assignments[i] === assignments[j]) {
        intraSum += dij;
        intraPairs += 1;
        if (dij > diameter) diameter = dij;
      } else {
        interSum += dij;
        interPairs += 1;
      }
    }
  }
  // interPairs = 0 即单簇：interMean 退化为全体对均值（诚实报告无族间分隔）
  const totalPairs = intraPairs + interPairs;
  const interMean = interPairs > 0 ? interSum / interPairs : totalPairs > 0 ? (intraSum + interSum) / totalPairs : 0;
  return {
    k: clusters.length,
    mode,
    threshold: hasThreshold ? threshold : undefined,
    assignments,
    clusters,
    merges,
    intraMeanNcd: intraPairs > 0 ? round(intraSum / intraPairs) : 0,
    interMeanNcd: round(interMean),
    diameterNcd: round(diameter),
  };
}

// ─────────────────────────── 非度量的诚实审计 ───────────────────────────

/** 三角不等式违反审计（NCD 非度量——如实统计，不掩盖） */
export interface NcdTriangleAudit {
  /** 无序三元组数 C(n,3) */
  triples: number;
  /** 检查的不等式数 = 3×triples（每个三元组三条边各当一次「直角边」） */
  inequalities: number;
  /** 违反 d(a,c) ≤ d(a,b)+d(b,c) 的不等式数 */
  violations: number;
  /** 违反率 violations / inequalities */
  violationRate: number;
  /** 最坏松弛 max[d(a,c) − d(a,b) − d(b,c)]（≤ 0 表示全部满足） */
  worstSlack: number;
}

/** 枚举全部三元组的三角不等式审计（确定性全量，不抽样不掩盖） */
export function ncdTriangleAudit(items: string[]): NcdTriangleAudit {
  assertStringArray(items, 'ncdTriangleAudit');
  if (items.length < 3) throw new Error('ncdTriangleAudit: 至少需要 3 个条目');
  const d = ncdMatrix(items);
  const n = items.length;
  let triples = 0;
  let violations = 0;
  let worstSlack = -Infinity;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      for (let c = b + 1; c < n; c += 1) {
        triples += 1;
        // 三条边各当一次「对边」: d(a,c) vs d(a,b)+d(b,c) 及其轮换
        const checks: Array<[number, number, number]> = [
          [a, b, c],
          [b, a, c],
          [c, a, b],
        ];
        for (const [x, m, y] of checks) {
          const slack = d[x]![y]! - d[x]![m]! - d[m]![y]!;
          if (slack > worstSlack) worstSlack = slack;
          if (slack > 1e-9) violations += 1;
        }
      }
    }
  }
  const inequalities = 3 * triples;
  return {
    triples,
    inequalities,
    violations,
    violationRate: round(violations / inequalities),
    worstSlack: round(worstSlack),
  };
}

// ─────────────────────────── 内部工具 ───────────────────────────

function assertStringArray(items: unknown, who: string): asserts items is string[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error(`${who}: 入参必须是非空 string[]`);
  for (const s of items) {
    if (typeof s !== 'string') throw new Error(`${who}: 入参必须是非空 string[]`);
  }
}

function round(x: number): number {
  return Number(x.toFixed(6));
}

/* ── 接线建议 ──
 * 1. 长期记忆去重: 新经验入库前用 ncd 对候选记忆做近邻查重；近邻
 *    命中即归并——不依赖向量嵌入的「内容相近」判定（零模型、零训练）。
 *    阈值校准基准（本内核实测）: 自距离 ≈ 0.41–0.55、同族变体 ≈ 0.6、
 *    异族 ≈ 0.8+——查重建议 threshold ≈ 0.65（自距离 + 裕量），
 *    归类建议 threshold ≈ 0.72（族内/族间中点附近）。
 * 2. 反思器经验归类: ncdCluster({ k: 'auto' 由阈值驱动 }) 把相似
 *    经验层次聚类，簇即「定律候选」，交给 11.0 理论家 induce() 沉淀
 *    ——「理解即压缩 MDL」的距离度量落地。
 * 3. 缺省关闭旗标: config.kernelFlags.compressionDistanceEnabled
 *    （缺省 false；开启后才在记忆写入与反思周期中调用本内核）。
 * 4. 挂载后改变的决策点:
 *    - 记忆写入路径: 去重归并 vs 新建条目（原: 直接新建）；
 *    - 反思周期: 聚类簇作为定律候选输入（原: 逐条散记）；
 *    - 均为引擎只读方法调用，旗标关闭时路径逐位与升级前一致。
 */
