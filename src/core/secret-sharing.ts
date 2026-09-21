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
