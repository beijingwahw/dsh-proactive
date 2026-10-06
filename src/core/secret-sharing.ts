/**
 * 48.0 秘密共享内核 —— Shamir 阈值 + 随机性审计：信任被分形，密钥被检验
 *
 * 动机: 主密钥单点保管 = 单点沦陷即全失。Shamir 秘密共享（1979）把
 * 秘密拆成 n 份、任意 t 份可重建、t−1 份**信息论零泄露**:
 *
 *   秘密 = 域 GF(p) 上 t−1 次多项式 f 的常数项，份额 = f(x_i)。
 *   重建 = t 个点上的 Lagrange 插值（任意 t 个点唯一确定 f ⟹ f(0)
 *   唯一）；t−1 个点对 f(0) 的每种猜测都存在唯一一致的多项式——
 *   **完备保密**（不是计算难度，是信息论意义：t−1 份与秘密统计独立）。
 *
 *   随机性审计（NIST SP 800-22 的两个核心检验）:
 *   - 频数检验: 1 的占比偏离 1/2 的 |χ| 口径（渐近 N(0,1)）
 *   - 游程检验: 游程数偏离期望（同值段切换次数的 χ² 口径）
 *   好的 PRNG 通过、偏置源被拒绝——「密钥的原料合格吗」可检查。
 *
 *   验证锚点: 任意 t 份子集重建成功（枚举）、t−1 份子集重建出
 *   随机等可能值（零泄露的实验读数）、Lagrange 恒等式、
 *   均匀字节通过审计 / 偏置字节被拒。
 *
 *   R5 第五轮进化:
 *   - 可验证秘密共享（Feldman VSS，轴 1 数学）: 点值承诺 C_j = g^{a_j}
 *     让每个持有者独立验证份额真伪（g^{f(x)} ≟ Π C_j^{x^j}）——Shamir
 *     的零泄露之上补「份额为真」；
 *   - 数值稳健性（轴 3）: 确定性 Miller–Rabin（64 位判别式证明而非
 *     概率）、modPowBig 溢出安全模幂、素域 Lagrange 任意点插值
 *     （modLagrangeEvaluate——shamirCombine 的数学一般化）。
 *
 * 零漂移: 纯函数内核（引擎按需使用），未挂载零介入。
 */

const PRIME = 2n ** 127n - 1n; // Mersenne 素数（BigInt 域，容量充分）

function modField(x: bigint): bigint {
  const r = x % PRIME;
  return r < 0n ? r + PRIME : r;
}

function inverse(a: bigint): bigint {
  // Fermat 小定理: a^(p-2) mod p（素域）
  let result = 1n;
  let base = modField(a);
  let exp = PRIME - 2n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % PRIME;
    base = (base * base) % PRIME;
    exp >>= 1n;
  }
  return result;
}

export interface ShamirShare {
  /** 份额点 x（非 0） */
  x: number;
  /** f(x)（域元素，字符串化 BigInt） */
  y: string;
}

/** Shamir 拆分：secret（UTF-8）→ n 份，阈值 t ≤ n 重建 */
export function shamirSplit(secret: string, n: number, threshold: number, rng?: () => number): ShamirShare[] {
  const parts = Math.max(2, Math.min(n, 255));
  const t = Math.max(2, Math.min(threshold, parts));
  if (!rng) {
    // 确定性缺省（验证口径）；生产路径应注入 crypto 随机
    let s = 0x9e3779b9;
    rng = () => {
      s = (Math.imul(s ^ (s >>> 15), 1 | s) | 0) >>> 0;
      return (s ^ (s >>> 13)) / 4294967296;
    };
  }
  const bytes = Buffer.from(secret, 'utf-8');
  // 多项式系数：每 16 字节块一组独立拆分（块内 Lagrange 一致处理）
  const coefficients: bigint[][] = [];
  const chunk = (bytes.length + 15) >> 4;
  for (let c = 0; c < chunk; c += 1) {
    const slice = bytes.subarray(c * 16, c * 16 + 16);
    const secretValue = BigInt(`0x${Buffer.from(slice).toString('hex') || '0'}`);
    const coeffs = [secretValue];
    for (let k = 1; k < t; k += 1) {
      let v = 0n;
      for (let b = 0; b < 16; b += 1) v = (v << 8n) | BigInt(Math.floor(rng() * 256) & 0xff);
      coeffs.push(v % PRIME);
    }
    coefficients.push(coeffs.map(modField));
  }
  const shares: ShamirShare[] = [];
  for (let x = 1; x <= parts; x += 1) {
    const ys = coefficients.map((coeffs) => {
      // Horner 求值 f(x)
      let acc = 0n;
      for (let k = coeffs.length - 1; k >= 0; k -= 1) {
        acc = (acc * BigInt(x) + coeffs[k]) % PRIME;
      }
      return acc;
    });
    // 多块拼接：块间定界（每块 32 hex 字符）
    shares.push({ x, y: ys.map((v) => v.toString(16).padStart(32, '0')).join('') });
  }
  return shares;
}

/** Shamir 重建：任意 ≥ 阈值份额 → 秘密（Lagrange 插值 f(0)） */
export function shamirCombine(shares: ReadonlyArray<ShamirShare>): string {
  if (shares.length < 2) throw new Error('shamirCombine: 至少 2 份');
  const blocks = shares[0]!.y.length / 32;
  const chunks: Buffer[] = [];
  for (let b = 0; b < blocks; b += 1) {
    let secret = 0n;
    for (let i = 0; i < shares.length; i += 1) {
      const xi = BigInt(shares[i]!.x);
      const yi = BigInt(`0x${shares[i]!.y.substr(b * 32, 32)}`);
      // Lagrange 基在 0 点：ℓ_i(0) = Π_{j≠i} x_j/(x_j − x_i)
      let num = 1n;
      let den = 1n;
      for (let j = 0; j < shares.length; j += 1) {
        if (i === j) continue;
        const xj = BigInt(shares[j]!.x);
        num = (num * xj) % PRIME;
        den = (den * modField(xj - xi)) % PRIME;
      }
      const weight = (num * inverse(den)) % PRIME;
      secret = (secret + yi * weight) % PRIME;
    }
    const hex = secret.toString(16).padStart(32, '0');
    chunks.push(Buffer.from(hex.slice(-32), 'hex'));
  }
  // 每块左去零（块值大端表示，短块的高位补零在块首——真实字节居尾；
  // 限制：秘密块首的真实零字节不可表示，hex 字符串密钥不受影响）
  const trimmed = chunks.map((c) => {
    let start = 0;
    while (start < c.length && c[start] === 0) start += 1;
    return c.subarray(start);
  });
  return Buffer.concat(trimmed).toString('utf-8');
}

export interface EntropyAudit {
  bytes: number;
  /** 频数检验：1 的占比（应 ≈ 0.5） */
  oneRatio: number;
  /** 频数 χ 统计量（渐近 N(0,1)；|χ| > 3 拒绝） */
  frequencyChi: number;
  /** 游程数（同值段数；期望 ≈ n/2） */
  runs: number;
  /** 游程偏离 z 口径 */
  runsZ: number;
  /** 综合判定（两项 |z| ≤ 3 通过） */
  passed: boolean;
}

/** 随机性审计（频数 + 游程检验；NIST SP 800-22 口径） */
export function entropyAudit(bytes: ReadonlyArray<number>): EntropyAudit {
  const n = bytes.length * 8;
  if (n < 64) throw new Error('entropyAudit: 至少 8 字节');
  let ones = 0;
  let switches = 0;
  let prev = -1;
  for (const byte of bytes) {
    for (let b = 7; b >= 0; b -= 1) {
      const bit = (byte >> b) & 1;
      ones += bit;
      if (prev >= 0 && bit !== prev) switches += 1;
      prev = bit;
    }
  }
  const oneRatio = ones / n;
  const frequencyChi = (ones - n / 2) / (Math.sqrt(n) / 2);
  const runs = switches + 1;
  const runsZ = (switches - n / 2 + 1) / Math.sqrt((n - 1) / 2);
  return {
    bytes: bytes.length,
    oneRatio,
    frequencyChi,
    runs,
    runsZ,
    passed: Math.abs(frequencyChi) <= 3 && Math.abs(runsZ) <= 3,
  };
}

// ═══════════════════ R5 第五轮进化：可验证秘密共享（Feldman VSS） ═══════════════════

/**
 * Feldman 域参数（R5 数学进化）。
 *
 * 安全素数 p = 2q + 1（p、q 皆素，63/62 比特）:
 *   p = 9223372036854778487 = 2 · 4611686018427389243 + 1
 * 由确定性 Miller–Rabin（isPrimeBig，见下）验证——素性是**证明**而非概率。
 * 素数阶子群: g = 4 生成 GF(p)* 的二次剩余子群（阶 q）——安全素数下
 * 任何 h ∉ {1, p−1} 的 h² 阶恰为 q（4 = 2² 且 p > 3），离散对数在
 * 该子群内 2q 阶群中安全归约。
 */
export const FELDMAN_P = 9223372036854778487n;
export const FELDMAN_Q = 4611686018427389243n;
export const FELDMAN_G = 4n;

/** 模幂（溢出安全：BigInt 逐平方，指数无上限） */
export function modPowBig(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod <= 0n) throw new Error('modPowBig: mod > 0');
  if (exp < 0n) throw new Error('modPowBig: exp ≥ 0');
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * 确定性 Miller–Rabin 素性判定（R5 数值稳健性进化）。
 *
 * 见证集 {2,3,5,7,11,13,17,19,23,29,31,37} 对 n < 3,317,044,064,679,887,385,
 * 961,981（≈3.3×10²⁴）是**确定性**的（Sorenson–Webster 2015）——64 位
 * 整数范围内本函数不是概率算法，是判别算法。零 import、纯 BigInt 运算。
 */
export function isPrimeBig(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n % p === 0n) return n === p;
  }
  let d = n - 1n;
  let s = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    s += 1n;
  }
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    let x = modPowBig(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let r = 1n; r < s; r += 1n) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

/** Feldman VSS 份额（数值域 GF(q)；x 为份额点、y 为 f(x)） */
export interface FeldmanShare {
  x: number;
  y: bigint;
}

/** 可验证拆分产物：份额 + 点值承诺 + 域参数 */
export interface VerifiableSplit {
  shares: FeldmanShare[];
  /** 承诺 C_j = g^{a_j} mod p（j = 0..t−1；C_0 承诺秘密本身） */
  commitments: bigint[];
  prime: bigint;
  order: bigint;
  generator: bigint;
}

/**
 * 可验证 Shamir 拆分（Feldman VSS；R5 数学进化）。
 *
 * 在 GF(q)（q = FELDMAN_Q）上取 t−1 次随机多项式 f、f(0) = secretValue，
 * 同时发布**点值承诺** C_j = g^{a_j} mod p——份额正确性可被任何人独立
 * 验证而**无需知道秘密**:
 *
 *   g^{f(x)} ≟ Π_{j=0}^{t−1} C_j^{x^j}  (mod p)
 *
 * （右边 = g^{Σ a_j x^j} = g^{f(x)}——承诺的同态性；g 阶为素数 q，
 * 指数在 GF(q) 中。分发者作弊（份额与承诺不符）会被持有者当场发现；
 * 份额被传输损坏同样当场发现——「信任被分形」之后是「份额被检验」）。
 * 与 48.0 的关系：48.0 保证 t−1 份零泄露，Feldman 补上「t 份里的每一
 * 份都是真的」——Shamir 的可验证化。secretValue 须在 [0, q) 内。
 */
export function verifiableShamirSplit(
  secretValue: bigint,
  n: number,
  threshold: number,
  rng?: () => number,
): VerifiableSplit {
  if (secretValue < 0n || secretValue >= FELDMAN_Q) throw new Error('verifiableShamirSplit: secretValue ∈ [0, q)');
  const parts = Math.max(2, Math.min(Math.floor(n), 255));
  const t = Math.max(2, Math.min(Math.floor(threshold), parts));
  if (!rng) {
    // 确定性缺省（验证口径）；生产路径应注入 crypto 随机
    let s = 0x9e3779b9;
    rng = () => {
      s = (Math.imul(s ^ (s >>> 15), 1 | s) | 0) >>> 0;
      return (s ^ (s >>> 13)) / 4294967296;
    };
  }
  const coeffs: bigint[] = [secretValue];
  for (let k = 1; k < t; k += 1) {
    // 均匀 GF(q)：拒绝采样（64 位采样，v ≥ q 重采；期望 ~4 次终止）
    let v = 0n;
    do {
      v = 0n;
      for (let w = 0; w < 8; w += 1) v = (v << 8n) | BigInt(Math.floor(rng() * 256) & 0xff);
    } while (v >= FELDMAN_Q);
    coeffs.push(v);
  }
  const shares: FeldmanShare[] = [];
  for (let x = 1; x <= parts; x += 1) {
    const bx = BigInt(x);
    let acc = 0n;
    for (let k = coeffs.length - 1; k >= 0; k -= 1) {
      acc = (acc * bx + coeffs[k]!) % FELDMAN_Q; // Horner 求值 GF(q)
    }
    shares.push({ x, y: acc });
  }
  const commitments = coeffs.map((a) => modPowBig(FELDMAN_G, a, FELDMAN_P));
  return { shares, commitments, prime: FELDMAN_P, order: FELDMAN_Q, generator: FELDMAN_G };
}

/**
 * Feldman 份额验证（公开可检验：只需承诺与份额，无需秘密）。
 *
 * g^y ≟ Π_j C_j^{x^j} (mod p)——承诺同态性的一步检验；返回 true =
 * 份额确系承诺多项式在 x 点的值（分发者无法对单个持有者撒谎）。
 */
export function verifyFeldmanShare(
  x: number,
  y: bigint,
  commitments: ReadonlyArray<bigint>,
  prime = FELDMAN_P,
  generator = FELDMAN_G,
): boolean {
  if (x < 1 || commitments.length < 2 || y < 0n) return false;
  let rhs = 1n;
  let xp = 1n; // x^j mod q（g 阶为 q，指数对 q 取模——溢出安全）
  const order = (prime - 1n) / 2n;
  for (let j = 0; j < commitments.length; j += 1) {
    rhs = (rhs * modPowBig(commitments[j]!, xp % order, prime)) % prime;
    xp = (xp * BigInt(x)) % order;
  }
  return modPowBig(generator, y % order, prime) === rhs;
}

/**
 * 素域上的 Lagrange 插值求值（任意点；R5 数学进化）。
 *
 * points = [(x_i, y_i)]（x_i 互异非零），返回 f(xq)——f 为过全部点的
 * 唯一 ≤ n−1 次插值多项式。shamirCombine 是本函数在 xq = 0、
 * 多块定界拼接下的特化。验证锚点：随机多项式采样 → 插值恢复多项式
 * 在任意点的值（与 Horner 直算逐位一致）。
 */
export function modLagrangeEvaluate(
  points: ReadonlyArray<{ x: bigint | number; y: bigint }>,
  xq: bigint | number,
  prime: bigint,
): bigint {
  if (points.length < 1) throw new Error('modLagrangeEvaluate: 至少 1 个点');
  const px = typeof xq === 'bigint' ? xq : BigInt(xq);
  const P = prime;
  const mod = (v: bigint): bigint => {
    const r = v % P;
    return r < 0n ? r + P : r;
  };
  const inv = (a: bigint): bigint => modPowBig(mod(a), P - 2n, P); // Fermat（P 素）
  let result = 0n;
  for (let i = 0; i < points.length; i += 1) {
    const xi = typeof points[i]!.x === 'bigint' ? (points[i]!.x as bigint) : BigInt(points[i]!.x as number);
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const xj = typeof points[j]!.x === 'bigint' ? (points[j]!.x as bigint) : BigInt(points[j]!.x as number);
      num = mod(num * mod(px - xj));
      den = mod(den * mod(xi - xj));
    }
    result = mod(result + mod(points[i]!.y) * mod(num * inv(den)));
  }
  return result;
}
