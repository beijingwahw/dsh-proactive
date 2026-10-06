/**
 * crypto-engine.ts — 加密引擎（基础层，无内部依赖）
 *
 * 职责：
 * - 记忆库文件的整体加密 / 解密（fullFileEncryption）
 * - 敏感字段（如 apiKey）的字段级加密 / 解密
 * - 密钥轮换（rotateKey）与多版本密钥链管理
 * - 原子化落盘，避免写入中途崩溃导致记忆库损坏
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 主密钥经 scrypt KDF 派生为 32 字节工作密钥，避免弱口令直接作密钥
 * 2. 密钥链（keychain）支持多版本密钥并存，轮换后历史数据仍可解密
 * 3. 原子写入（tmp + rename），杜绝半写状态的记忆文件
 * 4. 密钥指纹使用 timingSafeEqual 比较，防时序侧信道
 * 5. 敏感字段深度递归扫描，支持任意嵌套层级
 *
 * 第三轮升级（治理域 A13）：
 * 6. 信封加密：数据密钥（DK）加密业务数据，主密钥只包 DK（wrappedDk
 *    随密文自描述携带——跨实例可解）；按次数（rotateEveryNOperations）
 *    /时长（rotateAfterMs）自动轮换 DK；旧 DK 轮换后进入解密宽限期
 *    （graceMs），宽限期满退役——旧密文不可再解，新数据恒用新 DK
 * 7. Shamir 密钥托管升级（48.0 思想自实现兼容小工具）：份额自描述
 *    （k/n 元数据 + 防篡改指纹 + 保管人标签），恢复侧强制份额充足性
 *    （不足 k 份即拒——t−1 份不可恢复从「解出错误值」升级为「结构化拒绝」）
 * 8. 常量时间比较（自实现）：单循环 XOR 累积、无早退分支；等长输入的
 *    迭代次数恒等于长度，长度差折叠进累积器（不泄露长度差处的时序）
 *
 * 第四轮升级（治理域 R4-A13，全新维度）：
 * 9. 密钥分级：按数据敏感度分低/中/高三级密钥（主密钥按级域分隔派生，
 *    各级独立的差异化轮换周期与算法强度配置——低级可用 CBC、中高级
 *    强制 GCM）；分级轮换互不拖累（低级快轮、高级长周期）；错级使用
 *    检测：低级密钥加密高级数据 → 告警记账（默认）或结构化拒绝
 *    （onViolation='reject'），正确分级零告警；未配置零漂移
 *    （encryptTiered 结构化拒绝、tieredStatus/tieredAlerts undefined）
 */

import crypto from 'node:crypto';
import { shamirSplit, shamirCombine, entropyAudit } from '../core/secret-sharing.js';
import fs from 'node:fs';
import path from 'node:path';
import { CryptoError } from '../errors.js';

/** 加密引擎配置 */
export interface EncryptionConfig {
  /** 是否启用加密（关闭时 writeEncrypted 落明文 JSON） */
  enabled: boolean;
  /** 主密钥（任意字符串，内部经 scrypt 派生为工作密钥） */
  masterKey: string;
  /** 加密算法 */
  algorithm: 'aes-256-gcm' | 'aes-256-cbc';
  /** 需要字段级加密的字段名列表（递归匹配任意嵌套层级） */
  sensitiveFields: string[];
  /** 是否对整个文件加密（false 时仅加密敏感字段） */
  fullFileEncryption: boolean;
  /** 已轮换的历史主密钥（旧版本，用于解密历史数据） */
  rotatedKeys?: string[];
  /**
   * 第三轮：信封加密配置（opt-in；未配置时 encryptEnvelope/decryptEnvelope
   * 报错，全部既有路径行为不变——零漂移）
   */
  envelope?: EnvelopeConfig;
  /**
   * 第四轮：密钥分级配置（opt-in；未配置时 encryptTiered/decryptTiered
   * 报错、tieredStatus/tieredAlerts undefined——零漂移）
   */
  tiered?: TieredKeyOptions;
}

/** 信封加密配置（主密钥包数据密钥；DK 轮换与宽限期口径） */
export interface EnvelopeConfig {
  /** 单个数据密钥的最大加密次数（达到即在下次加密前轮换新 DK） */
  rotateEveryNOperations?: number;
  /** 数据密钥最长使用时长 ms（达到即在下次加密前轮换新 DK） */
  rotateAfterMs?: number;
  /** 旧数据密钥轮换后的解密宽限期 ms（期满退役：旧密文不可再解） */
  graceMs?: number;
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
}

/** 信封加密产物（DK 加密数据；wrappedDk 随载荷自描述携带） */
export interface EnvelopedPayload {
  __envelope: true;
  version: 1;
  /** 数据密钥版本（每次轮换 +1；v1 为首个 DK） */
  keyVersion: number;
  /** 打包 DK 时使用的主密钥版本（跨主密钥轮换仍可解包） */
  masterKeyVersion: number;
  /** 被主密钥包裹的数据密钥（信封本体） */
  wrappedDk: { iv: string; tag?: string; ciphertext: string };
  /** 业务数据密文（DK 加密） */
  content: { iv: string; tag?: string; ciphertext: string };
  algorithm: string;
  createdAt: number;
}

/** 信封加密状态读数（治理可观测口径） */
export interface EnvelopeStatus {
  currentKeyVersion: number;
  /** 当前 DK 已加密次数 */
  operations: number;
  /** 累计轮换次数 */
  rotations: number;
  /** 当前 DK 生效时刻 */
  activeSince: number;
  /** 已退役 DK（宽限期口径） */
  retired: Array<{
    keyVersion: number;
    retiredAt: number;
    graceUntil: number;
    graceExpired: boolean;
  }>;
}

/** Shamir 托管份额（自描述：阈值元数据 + 防篡改指纹 + 保管人标签） */
export interface KeyEscrowShare {
  x: number;
  y: string;
  /** 阈值 k（combine 侧据此强制份额充足性） */
  k: number;
  /** 总份数 n */
  n: number;
  /** 份额指纹（SHA-256(x:y) 前 16 hex；篡改检测） */
  digest: string;
  /** 保管人标签（份额分存审计口径） */
  custodian?: string;
}

/** 主密钥托管计划（不含主密钥本体——分存于各保管人） */
export interface KeyEscrowPlan {
  n: number;
  k: number;
  createdAt: number;
  shares: KeyEscrowShare[];
  /** 主密钥派生工作密钥的指纹（恢复后校验恢复正确性；不泄露主密钥原料） */
  keyFingerprint: string;
}

// ─────────────── 第四轮：密钥分级（按数据敏感度分级的密钥体系） ───────────────

/** 密钥分级（低 / 中 / 高；数据密级同名口径） */
export type CryptoKeyTier = 'low' | 'medium' | 'high';

/** 单级密钥策略（差异化轮换周期 + 算法强度） */
export interface TieredKeyPolicy {
  /** 该级密钥轮换周期 ms（使用时长达限 → 下次加密前轮换新钥） */
  rotateAfterMs: number;
  /**
   * 该级算法（算法强度配置）：low 允许 'aes-256-cbc'（缺省）或
   * 'aes-256-gcm'；medium / high 强制 'aes-256-gcm'（缺省）——
   * 认证加密不向敏感级妥协
   */
  algorithm?: 'aes-256-gcm' | 'aes-256-cbc';
}

/** 密钥分级配置（三级均须给出） */
export interface TieredKeyOptions {
  tiers: Record<CryptoKeyTier, TieredKeyPolicy>;
  /** 错级处置：alert（放行 + 告警记账 + 载荷携带违规位，缺省）/ reject（结构化拒绝） */
  onViolation?: 'alert' | 'reject';
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
}

/** 分级加密产物（载荷自描述分级与密级声明） */
export interface TieredPayload {
  __tiered: true;
  version: 1;
  /** 加密所用密钥级别 */
  tier: CryptoKeyTier;
  /** 数据密级声明（错级检测口径；未声明 → 视为与 tier 同级） */
  classification: CryptoKeyTier;
  keyVersion: number;
  algorithm: 'aes-256-gcm' | 'aes-256-cbc';
  iv: string;
  tag?: string;
  ciphertext: string;
  createdAt: number;
  /** 错级使用标记（onViolation='alert' 时仍产出，携带违规位供下游拦截） */
  policyViolation?: boolean;
}

/** 单级密钥状态读数 */
export interface TieredKeyStatus {
  tier: CryptoKeyTier;
  keyVersion: number;
  operations: number;
  rotations: number;
  /** 当前密钥生效时刻 */
  activeSince: number;
  /** 下次轮换到期时刻（activeSince + rotateAfterMs） */
  rotateDueAt: number;
  algorithm: string;
}

/** 错级使用告警条目（低级密钥加密高级数据） */
export interface TieredMisuseAlert {
  at: number;
  tier: CryptoKeyTier;
  classification: CryptoKeyTier;
  message: string;
}

/** 字段级加密产物 */
export interface EncryptedField {
  __encrypted: true;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
}

/** 整文件加密产物 */
export interface EncryptedFile {
  __encrypted_file: true;
  version: number;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
  createdAt: number;
}

/** 加密操作结果 */
export interface CryptoResult {
  success: boolean;
  error?: string;
  fieldsEncrypted?: number;
  fieldsDecrypted?: number;
  fileEncrypted?: boolean;
  fileDecrypted?: boolean;
  keyRotated?: boolean;
}

/** scrypt 派生固定盐（项目域隔离） */
const KDF_SALT = 'dsh-proactive:v1:kdf';
/** AES-256 工作密钥长度 */
const KEY_LENGTH = 32;
/** GCM 推荐 IV 长度 */
const GCM_IV_LENGTH = 12;
/** CBC IV 长度 */
const CBC_IV_LENGTH = 16;

/** 主密钥 → 工作密钥派生（模块级：实例与静态路径共用同一口径） */
function deriveWorkingKey(masterKey: string): Buffer {
  if (!masterKey) {
    throw new CryptoError('主密钥不能为空');
  }
  return crypto.scryptSync(masterKey, KDF_SALT, KEY_LENGTH);
}

/** Shamir 份额指纹（SHA-256(x:y) 前 16 hex；份额级防篡改，不泄露秘密） */
function escrowShareDigest(x: number, y: string): string {
  return crypto.createHash('sha256').update(`${x}:${y}`, 'utf-8').digest('hex').slice(0, 16);
}

/** 密钥级别序（错级检测的比较口径：rank(tier) < rank(classification) 即错级） */
const TIER_RANK: Record<CryptoKeyTier, number> = { low: 1, medium: 2, high: 3 };
/** 级别枚举序（状态读数的稳定排序口径） */
const TIER_ORDER: readonly CryptoKeyTier[] = ['low', 'medium', 'high'];

/** 主密钥 → 指定级工作密钥派生（级域分隔盐：三级密钥互不可推导） */
function deriveTierKey(masterKey: string, tier: CryptoKeyTier): Buffer {
  return crypto.scryptSync(masterKey, `${KDF_SALT}:tier:${tier}`, KEY_LENGTH);
}

/**
 * 加密引擎
 *
 * 提供文件级与字段级两种加密粒度，以及密钥轮换能力。
 * 被 LongTermMemory（持久化加密）、DistributedSync（同步载荷加密）、
 * BenchmarkEngine（报告加密）依赖。
 */
export class CryptoEngine {
  private config: EncryptionConfig;
  /** 密钥链：index 0 对应 keyVersion 1，依次递增 */
  private keychain: Buffer[] = [];
  /** 第三轮：信封加密状态（config.envelope 存在时于构造器铸出首个 DK） */
  private envelope?: {
    keyVersion: number;
    dk: Buffer;
    masterKeyVersion: number;
    wrapped: { iv: string; tag?: string; ciphertext: string };
    opCount: number;
    createdAt: number;
    rotations: number;
    /** 退役账本：keyVersion → 退役时刻（宽限期自该时刻起算） */
    retired: Map<number, number>;
  };
  /** 第四轮：密钥分级状态（config.tiered 存在时于构造器铸出三级密钥） */
  private tiered?: {
    clock: () => number;
    onViolation: 'alert' | 'reject';
    tiers: Map<CryptoKeyTier, {
      keyVersion: number;
      current: Buffer;
      /** 全版本密钥账本（轮换后旧密文仍可解） */
      history: Map<number, Buffer>;
      algorithm: 'aes-256-gcm' | 'aes-256-cbc';
      rotateAfterMs: number;
      activeSince: number;
      operations: number;
      rotations: number;
    }>;
    alerts: TieredMisuseAlert[];
  };

  constructor(config: EncryptionConfig) {
    this.config = { ...config, rotatedKeys: [...(config.rotatedKeys ?? [])] };
    // 构建密钥链：历史轮换密钥在前，当前主密钥在最后（版本号最大）
    for (const oldKey of this.config.rotatedKeys ?? []) {
      this.keychain.push(deriveWorkingKey(oldKey));
    }
    this.keychain.push(deriveWorkingKey(this.config.masterKey));
    // 信封加密启用：铸出首个数据密钥（keyVersion 1，被当前主密钥包裹）
    if (this.config.envelope) {
      this.mintEnvelopeDk(this.envelopeNow());
    }
    // 密钥分级启用：按级域分隔派生三级初始密钥（keyVersion 各自独立从 1 起）
    if (this.config.tiered) {
      this.tiered = {
        clock: this.config.tiered.clock ?? (() => Date.now()),
        onViolation: this.config.tiered.onViolation === 'reject' ? 'reject' : 'alert',
        tiers: new Map(),
        alerts: [],
      };
      const now = this.tiered.clock();
      for (const tier of TIER_ORDER) {
        const policy = this.config.tiered.tiers[tier];
        if (!policy || !Number.isFinite(policy.rotateAfterMs) || policy.rotateAfterMs <= 0) {
          throw new CryptoError(`密钥分级配置非法：${tier} 级缺少有效 rotateAfterMs（> 0 有限值）`);
        }
        const algorithm =
          policy.algorithm ??
          (tier === 'low' ? 'aes-256-cbc' : 'aes-256-gcm');
        if (tier !== 'low' && algorithm !== 'aes-256-gcm') {
          throw new CryptoError(`密钥分级配置非法：${tier} 级强制 aes-256-gcm（认证加密不向敏感级妥协）`);
        }
        const key = deriveTierKey(this.config.masterKey, tier);
        this.tiered.tiers.set(tier, {
          keyVersion: 1,
          current: key,
          history: new Map([[1, key]]),
          algorithm,
          rotateAfterMs: policy.rotateAfterMs,
          activeSince: now,
          operations: 0,
          rotations: 0,
        });
      }
    }
  }

  /**
   * 加密整段内容为 EncryptedFile 结构
   * @param content 明文字符串（通常是 JSON.stringify 的结果）
   */
  encryptFile(content: string): EncryptedFile {
    const keyVersion = this.currentKeyVersion();
    const { ciphertext, iv, tag } = this.encryptRaw(content, this.currentKey());
    return {
      __encrypted_file: true,
      version: 1,
      algorithm: this.config.algorithm,
      iv,
      tag,
      ciphertext,
      keyVersion,
      createdAt: Date.now(),
    };
  }

  /**
   * 解密 EncryptedFile 结构，还原明文
   * @param file 加密文件结构
   * @throws CryptoError 密钥缺失或认证标签校验失败
   */
  decryptFile(file: EncryptedFile): string {
    const key = this.getKeyByVersion(file.keyVersion);
    return this.decryptRaw(
      { ciphertext: file.ciphertext, iv: file.iv, tag: file.tag },
      key,
      file.algorithm as EncryptionConfig['algorithm'],
    );
  }

  /**
   * 递归加密对象中的敏感字段
   * @param obj 任意对象（不会被原地修改，返回深拷贝）
   * @returns 加密后的对象与被加密字段数
   */
  encryptSensitiveFields(obj: any): { result: any; encryptedCount: number } {
    let count = 0;
    const walk = (node: any): any => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(walk);
      // 已加密的字段保持原样
      if ((node as EncryptedField).__encrypted === true) return node;
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(node)) {
        if (this.config.sensitiveFields.includes(key) && typeof value === 'string' && value.length > 0) {
          out[key] = this.encryptStringToField(value);
          count += 1;
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    };
    return { result: walk(structuredClone(obj)), encryptedCount: count };
  }

  /**
   * 递归解密对象中所有 EncryptedField 结构
   * @param obj 含加密字段的对象（不会被原地修改，返回深拷贝）
   * @returns 解密后的对象与被解密字段数
   */
  decryptSensitiveFields(obj: any): { result: any; decryptedCount: number } {
    let count = 0;
    const walk = (node: any): any => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(walk);
      if ((node as EncryptedField).__encrypted === true) {
        const field = node as EncryptedField;
        const key = this.getKeyByVersion(field.keyVersion);
        count += 1;
        return this.decryptRaw(
          { ciphertext: field.ciphertext, iv: field.iv, tag: field.tag },
          key,
          field.algorithm as EncryptionConfig['algorithm'],
        );
      }
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = walk(value);
      }
      return out;
    };
    return { result: walk(structuredClone(obj)), decryptedCount: count };
  }

  /**
   * 将数据加密后写入文件（原子写入）
   *
   * 行为矩阵：
   * - enabled && fullFileEncryption  → 整文件加密
   * - enabled && !fullFileEncryption → 仅加密敏感字段后写明文 JSON
   * - !enabled                       → 直接写明文 JSON
   */
  writeEncrypted(filePath: string, data: any): CryptoResult {
    try {
      if (!this.config.enabled) {
        this.atomicWrite(filePath, JSON.stringify(data, null, 2));
        return { success: true, fileEncrypted: false };
      }
      if (this.config.fullFileEncryption) {
        const encrypted = this.encryptFile(JSON.stringify(data));
        this.atomicWrite(filePath, JSON.stringify(encrypted));
        return { success: true, fileEncrypted: true };
      }
      const { result, encryptedCount } = this.encryptSensitiveFields(data);
      this.atomicWrite(filePath, JSON.stringify(result, null, 2));
      return { success: true, fileEncrypted: false, fieldsEncrypted: encryptedCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * 读取文件并自动解密（兼容明文 / 字段加密 / 整文件加密三种形态）
   */
  readEncrypted(filePath: string): { data: any; result: CryptoResult } {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // 形态一：整文件加密
      if (parsed && typeof parsed === 'object' && parsed.__encrypted_file === true) {
        const plain = this.decryptFile(parsed as EncryptedFile);
        return { data: JSON.parse(plain), result: { success: true, fileDecrypted: true } };
      }
      // 形态二 / 三：字段加密或纯明文
      const { result, decryptedCount } = this.decryptSensitiveFields(parsed);
      return {
        data: result,
        result: { success: true, fileDecrypted: false, fieldsDecrypted: decryptedCount },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CryptoError(`读取加密文件失败: ${filePath}`, { cause: message });
    }
  }

  /**
   * 密钥轮换：用新主密钥重新加密指定文件
   * @param filePath 目标文件
   * @param newMasterKey 新主密钥
   * @param keepOldKey 是否保留旧密钥到 rotatedKeys（保留后历史 keyVersion 仍可解密）
   */
  rotateKey(filePath: string, newMasterKey: string, keepOldKey = true): CryptoResult {
    try {
      // 1. 用当前密钥链读出明文数据
      const { data } = this.readEncrypted(filePath);
      // 2. 旧主密钥归档
      if (keepOldKey) {
        this.config.rotatedKeys = [...(this.config.rotatedKeys ?? []), this.config.masterKey];
      }
      // 3. 切换主密钥并扩展密钥链
      this.config.masterKey = newMasterKey;
      this.keychain.push(this.deriveKey(newMasterKey));
      // 4. 用新密钥重写文件
      const writeResult = this.writeEncrypted(filePath, data);
      if (!writeResult.success) {
        return { success: false, error: writeResult.error };
      }
      return { ...writeResult, keyRotated: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * 生成随机主密钥（64 位 hex）
   */
  static generateKey(): string {
    return crypto.randomBytes(KEY_LENGTH).toString('hex');
  }

  // ─────────────── 第三轮：信封加密（主密钥包数据密钥 + 轮换 + 宽限期） ───────────────

  /**
   * 信封加密：业务数据用数据密钥（DK）加密，DK 被当前主密钥包裹后随载荷
   * 携带（wrappedDk 自描述——任何持有主密钥的实例可解，DK 不落明文）。
   *
   * 轮换口径：进入本方法先检查当前 DK——加密次数达 rotateEveryNOperations
   * 或使用时长达 rotateAfterMs，即把当前 DK 记入退役账本（宽限期自此刻
   * 起算）并铸出新 DK（keyVersion +1）；新数据恒用新 DK。
   *
   * @param plaintext 明文字符串
   * @throws CryptoError 未启用信封加密（config.envelope 缺失）
   */
  encryptEnvelope(plaintext: string): EnvelopedPayload {
    if (!this.config.envelope || !this.envelope) {
      throw new CryptoError('信封加密未启用（EncryptionConfig.envelope 缺失）');
    }
    this.rotateEnvelopeIfNeeded();
    const env = this.envelope;
    const content = this.encryptRaw(plaintext, env.dk);
    env.opCount += 1;
    return {
      __envelope: true,
      version: 1,
      keyVersion: env.keyVersion,
      masterKeyVersion: env.masterKeyVersion,
      wrappedDk: env.wrapped,
      content,
      algorithm: this.config.algorithm,
      createdAt: this.envelopeNow(),
    };
  }

  /**
   * 信封解密：按载荷自描述的 masterKeyVersion 取主密钥解包 DK，
   * 再用 DK 解业务密文。
   *
   * 宽限退役口径：载荷的 keyVersion 早于当前版本且已在退役账本中、
   * 且距退役时刻超过 graceMs → 拒绝解密（旧密钥已退役）；
   * 宽限期内旧密文仍可解（滚动迁移窗口）。
   *
   * @throws CryptoError 未启用信封加密 / 旧 DK 已过宽限期 / 认证失败
   */
  decryptEnvelope(payload: EnvelopedPayload): string {
    if (!this.config.envelope) {
      throw new CryptoError('信封加密未启用（EncryptionConfig.envelope 缺失）');
    }
    const graceMs = this.config.envelope.graceMs ?? 0;
    if (this.envelope && payload.keyVersion < this.envelope.keyVersion) {
      const retiredAt = this.envelope.retired.get(payload.keyVersion);
      if (retiredAt !== undefined && this.envelopeNow() - retiredAt > graceMs) {
        throw new CryptoError(`数据密钥 v${payload.keyVersion} 已过解密宽限期退役（宽限 ${graceMs}ms 满）`, {
          keyVersion: payload.keyVersion,
          retiredAt,
        });
      }
    }
    const masterKey = this.getKeyByVersion(payload.masterKeyVersion);
    const dkHex = this.decryptRaw(
      payload.wrappedDk,
      masterKey,
      payload.algorithm as EncryptionConfig['algorithm'],
    );
    const dk = Buffer.from(dkHex, 'hex');
    return this.decryptRaw(payload.content, dk, payload.algorithm as EncryptionConfig['algorithm']);
  }

  /** 信封加密状态读数（未启用 → undefined 诚实降级） */
  envelopeStatus(): EnvelopeStatus | undefined {
    if (!this.config.envelope || !this.envelope) return undefined;
    const graceMs = this.config.envelope.graceMs ?? 0;
    const now = this.envelopeNow();
    return {
      currentKeyVersion: this.envelope.keyVersion,
      operations: this.envelope.opCount,
      rotations: this.envelope.rotations,
      activeSince: this.envelope.createdAt,
      retired: [...this.envelope.retired.entries()]
        .map(([keyVersion, retiredAt]) => ({
          keyVersion,
          retiredAt,
          graceUntil: retiredAt + graceMs,
          graceExpired: now - retiredAt > graceMs,
        }))
        .sort((a, b) => a.keyVersion - b.keyVersion),
    };
  }

  /** 信封时钟（注入优先；缺省 Date.now） */
  private envelopeNow(): number {
    return this.config.envelope?.clock?.() ?? Date.now();
  }

  /** 铸出新数据密钥：随机 DK → 当前主密钥包裹 → 记录主密钥版本 */
  private mintEnvelopeDk(now: number): void {
    const dk = crypto.randomBytes(KEY_LENGTH);
    const wrapped = this.encryptRaw(dk.toString('hex'), this.currentKey());
    this.envelope = {
      keyVersion: (this.envelope?.keyVersion ?? 0) + 1,
      dk,
      masterKeyVersion: this.currentKeyVersion(),
      wrapped,
      opCount: 0,
      createdAt: now,
      rotations: this.envelope?.rotations ?? 0,
      retired: this.envelope?.retired ?? new Map<number, number>(),
    };
  }

  /** DK 到期检查：满足任一轮换条件即退役旧 DK 并铸新 DK */
  private rotateEnvelopeIfNeeded(): void {
    const cfg = this.config.envelope!;
    const env = this.envelope!;
    const now = this.envelopeNow();
    const byOps = cfg.rotateEveryNOperations !== undefined && env.opCount >= cfg.rotateEveryNOperations;
    const byAge = cfg.rotateAfterMs !== undefined && now - env.createdAt >= cfg.rotateAfterMs;
    if (byOps || byAge) {
      env.retired.set(env.keyVersion, now);
      env.rotations += 1;
      this.mintEnvelopeDk(now);
    }
  }

  // ─────────────── 第四轮：密钥分级（差异化轮换 + 算法强度 + 错级检测） ───────────────

  /**
   * 分级加密：数据用指定级密钥加密（级域分隔派生、独立版本链、按级算法）。
   *
   * 轮换口径：进入本方法先检查该级密钥使用时长——达 rotateAfterMs 即
   * 轮换新钥（keyVersion +1，随机钥；旧钥进全版本账本供旧密文解密）；
   * 各级轮换周期独立计时，低级快轮不拖累高级长周期。
   *
   * 错级检测：classification 声明的数据密级高于加密所用 tier 时——
   * onViolation='reject'（结构化拒绝）或 'alert'（放行 + 告警记账 +
   * 载荷携带 policyViolation 位，缺省）。
   *
   * @param plaintext 明文字符串
   * @param tier 加密所用密钥级别
   * @param classification 数据密级声明（缺省视为与 tier 同级）
   * @throws CryptoError 未启用分级 / 错级且 onViolation='reject'
   */
  encryptTiered(plaintext: string, tier: CryptoKeyTier, classification?: CryptoKeyTier): TieredPayload {
    if (!this.config.tiered || !this.tiered) {
      throw new CryptoError('密钥分级未启用（EncryptionConfig.tiered 缺失）');
    }
    const st = this.tiered.tiers.get(tier);
    if (!st) {
      throw new CryptoError(`未知密钥级别: ${tier}（须为 low / medium / high）`);
    }
    const cls = classification ?? tier;
    // 自有属性校验：原型链继承键（如 'toString'/'constructor'）会被 truthy
    // 检查放过并静默按非违规入账
    if (!Object.prototype.hasOwnProperty.call(TIER_RANK, cls)) {
      throw new CryptoError(`未知数据密级: ${cls}（须为 low / medium / high）`);
    }
    const now = this.tiered.clock();
    // 分级轮换：使用时长达限 → 加密前先轮换（各级独立计时）
    if (now - st.activeSince >= st.rotateAfterMs) {
      const fresh = crypto.randomBytes(KEY_LENGTH);
      st.keyVersion += 1;
      st.current = fresh;
      st.history.set(st.keyVersion, fresh);
      st.activeSince = now;
      st.rotations += 1;
    }
    // 错级检测：低级密钥加密高级数据
    let violation = false;
    if (TIER_RANK[cls] > TIER_RANK[tier]) {
      const message = `错级使用：${cls} 级数据被 ${tier} 级密钥加密（低级密钥不得保护高级数据）`;
      if (this.tiered.onViolation === 'reject') {
        throw new CryptoError(message, { tier, classification: cls });
      }
      this.tiered.alerts.push({ at: now, tier, classification: cls, message });
      violation = true;
    }
    const { ciphertext, iv, tag } = this.encryptRawWith(plaintext, st.current, st.algorithm);
    st.operations += 1;
    const payload: TieredPayload = {
      __tiered: true,
      version: 1,
      tier,
      classification: cls,
      keyVersion: st.keyVersion,
      algorithm: st.algorithm,
      iv,
      tag,
      ciphertext,
      createdAt: now,
    };
    if (violation) payload.policyViolation = true;
    return payload;
  }

  /**
   * 分级解密：按载荷自描述的 tier 取该级版本账本中的密钥解密
   * （轮换后旧 keyVersion 仍可解——全版本账本口径）。
   * @throws CryptoError 未启用分级 / 密钥版本不在账本（跨实例或未铸出）
   */
  decryptTiered(payload: TieredPayload): string {
    if (!this.config.tiered || !this.tiered) {
      throw new CryptoError('密钥分级未启用（EncryptionConfig.tiered 缺失）');
    }
    const st = this.tiered.tiers.get(payload.tier);
    if (!st) {
      throw new CryptoError(`未知密钥级别: ${payload.tier}`);
    }
    const key = st.history.get(payload.keyVersion);
    if (!key) {
      throw new CryptoError(`分级密钥版本 ${payload.tier}/v${payload.keyVersion} 不在版本账本中（可能来自另一实例）`, {
        tier: payload.tier,
        keyVersion: payload.keyVersion,
      });
    }
    return this.decryptRaw(
      { ciphertext: payload.ciphertext, iv: payload.iv, tag: payload.tag },
      key,
      payload.algorithm,
    );
  }

  /** 分级密钥状态读数（low → medium → high 稳定序；未启用 → undefined） */
  tieredStatus(): TieredKeyStatus[] | undefined {
    if (!this.tiered) return undefined;
    const now = this.tiered.clock();
    return TIER_ORDER.map((tier) => {
      const st = this.tiered!.tiers.get(tier)!;
      return {
        tier,
        keyVersion: st.keyVersion,
        operations: st.operations,
        rotations: st.rotations,
        activeSince: st.activeSince,
        rotateDueAt: st.activeSince + st.rotateAfterMs,
        algorithm: st.algorithm,
      };
    });
  }

  /** 错级使用告警账本（未启用 → undefined；时间序） */
  tieredAlerts(): TieredMisuseAlert[] | undefined {
    if (!this.tiered) return undefined;
    return this.tiered.alerts.map((a) => ({ ...a }));
  }

  // ─────────────── 48.0 秘密共享 + 随机性审计（增量口径，零漂移） ───────────────

  /**
   * 48.0：主密钥阈值分形（Shamir，n 份中任意 t 份可重建、t−1 份
   * 信息论零泄露）。份额应分存于不同介质/保管人；本方法不落盘。
   */
  shardKey(keyHex: string, shares: number, threshold: number): Array<{ x: number; y: string }> {
    return shamirSplit(keyHex, shares, threshold, () => crypto.randomBytes(4).readUInt32BE(0) / 4294967296);
  }

  /** 48.0：份额重建（任意 ≥ 阈值份；Lagrange 插值） */
  combineKeyShares(shareList: ReadonlyArray<{ x: number; y: string }>): string {
    return shamirCombine(shareList);
  }

  /**
   * 48.0：密钥原料随机性审计（频数 + 游程检验，NIST SP 800-22 口径）——
   * 「密钥的原料合格吗」从信任变成检查（|z| ≤ 3 通过）。
   */
  auditKeyEntropy(keyHex: string): { bytes: number; oneRatio: number; frequencyChi: number; runsZ: number; passed: boolean } {
    return entropyAudit([...Buffer.from(keyHex, 'hex')]);
  }

  // ─────────────── 第三轮：Shamir 密钥托管升级（份额自描述 + 恢复强校验） ───────────────

  /**
   * 主密钥阈值托管（k-of-n，48.0 思想）：份额自描述携带 k/n 元数据与
   * 防篡改指纹，可标注保管人；计划本体只携带派生密钥指纹（校验恢复
   * 正确性用，不泄露主密钥原料）。份额应分存于不同介质/保管人。
   *
   * 编码层：主密钥先 UTF-8 → hex 再拆分——48.0 内核按 16 字节分块、
   * 块值以 128 位大端整数模入 Mersenne 素域 2^127−1，块首字节 ≥ 0x80
   * 的原始字节（如多字节 UTF-8）会被模域折叠损坏；hex ASCII（< 0x80）
   * 恒在值域内。恢复侧（recoverMasterKey）对应解码。
   *
   * @param masterKey 主密钥（任意字符串）
   * @param options n 总份数、k 阈值（2 ≤ k ≤ n ≤ 255）、custodians 保管人
   *        标签（按份额序）、rng 确定性随机源（验证口径；缺省 crypto 随机）
   */
  static escrowMasterKey(
    masterKey: string,
    options: { n: number; k: number; custodians?: string[]; rng?: () => number },
  ): KeyEscrowPlan {
    const { n, k } = options;
    if (!masterKey) {
      throw new CryptoError('主密钥不能为空');
    }
    if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) {
      throw new CryptoError(`非法托管参数：须满足 2 ≤ k ≤ n ≤ 255（收到 k=${k}, n=${n}）`);
    }
    const rng =
      options.rng ??
      (() => crypto.randomBytes(4).readUInt32BE(0) / 4294967296);
    const raw = shamirSplit(CryptoEngine.escrowEncode(masterKey), n, k, rng);
    const shares: KeyEscrowShare[] = raw.map((s, i) => ({
      x: s.x,
      y: s.y,
      k,
      n,
      digest: escrowShareDigest(s.x, s.y),
      custodian: options.custodians?.[i],
    }));
    return {
      n,
      k,
      createdAt: Date.now(),
      shares,
      keyFingerprint: crypto.createHash('sha256').update(deriveWorkingKey(masterKey)).digest('hex').slice(0, 16),
    };
  }

  /**
   * 托管恢复（强校验版 combine）：份额参数一致性 / 指纹防篡改 / x 坐标
   * 去重 / 份额充足性（< k 份结构化拒绝——t−1 份信息论零泄露，不可恢复
   * 从「插值出错误值」升级为「结构化拒绝」）全部通过后才做 Lagrange 重建。
   *
   * @returns 恢复的主密钥与派生密钥指纹（与托管计划的 keyFingerprint 比对
   *          即可证明恢复正确）
   * @throws CryptoError 份额不足 / 份额被篡改 / 份额参数不一致 / x 重复
   */
  static recoverMasterKey(
    shares: ReadonlyArray<KeyEscrowShare>,
  ): { masterKey: string; fingerprint: string } {
    if (shares.length < 2) {
      throw new CryptoError(`份额不足：${shares.length} 份（至少 2 份方可插值）`);
    }
    const { k, n } = shares[0];
    for (const s of shares) {
      if (s.k !== k || s.n !== n) {
        throw new CryptoError('份额参数不一致（不同托管计划的份额被混用）');
      }
      if (escrowShareDigest(s.x, s.y) !== s.digest) {
        throw new CryptoError(`份额 ${s.x} 指纹校验失败（可能被篡改）`);
      }
    }
    const xs = new Set(shares.map((s) => s.x));
    if (xs.size !== shares.length) {
      throw new CryptoError('份额 x 坐标重复（同一份额被计入两次）');
    }
    if (shares.length < k) {
      throw new CryptoError(`份额不足：${shares.length} < 阈值 ${k}（k-of-n 不可恢复）`);
    }
    const encoded = shamirCombine(shares.map((s) => ({ x: s.x, y: s.y })));
    const masterKey = CryptoEngine.escrowDecode(encoded);
    return {
      masterKey,
      fingerprint: crypto.createHash('sha256').update(deriveWorkingKey(masterKey)).digest('hex').slice(0, 16),
    };
  }

  /** 托管编码：任意字符串 → hex（48.0 内核值域安全形态） */
  private static escrowEncode(masterKey: string): string {
    return Buffer.from(masterKey, 'utf-8').toString('hex');
  }

  /** 托管解码：hex → 任意字符串（无效 hex 字节按丢失处理，指纹比对兜底） */
  private static escrowDecode(encoded: string): string {
    return Buffer.from(encoded, 'hex').toString('utf-8');
  }

  /**
   * 获取指定版本密钥的指纹（SHA-256 前 16 位 hex），用于安全展示与比对
   * @param version 密钥版本，缺省为当前版本
   */
  getKeyFingerprint(version?: number): string {
    const v = version ?? this.currentKeyVersion();
    const key = this.getKeyByVersion(v);
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /**
   * 判断磁盘文件是否为整文件加密形态
   */
  static isFileEncrypted(filePath: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' && parsed.__encrypted_file === true;
    } catch {
      return false;
    }
  }

  /**
   * 判断对象中是否包含加密字段（任意嵌套层级）
   */
  static hasEncryptedFields(obj: any): boolean {
    const walk = (node: any): boolean => {
      if (node === null || typeof node !== 'object') return false;
      if (Array.isArray(node)) return node.some(walk);
      if (node.__encrypted === true) return true;
      return Object.values(node).some(walk);
    };
    return walk(obj);
  }

  /**
   * 时序安全的指纹比对（防时序侧信道；第三轮起走自实现常量时间路径）
   * @param a 指纹 A
   * @param b 指纹 B
   */
  static safeCompareFingerprint(a: string, b: string): boolean {
    return CryptoEngine.constantTimeCompare(a, b);
  }

  /**
   * 第三轮：常量时间字节比较（自实现，防时序侧信道）。
   *
   * 单循环 XOR 累积、无早退分支：等长输入的迭代次数恒等于长度（与
   * 内容、与失配位置无关）；长度差折叠进累积器（不等长也不在循环
   * 边界处泄露长度信息）。密文 / 令牌比较统一走此路径。
   *
   * @param a 比较方 A（字符串按 UTF-8 取字节）
   * @param b 比较方 B
   * @param trace 可选观测器：回填实际迭代次数（验证「等长比较迭代恒定」）
   */
  static constantTimeCompare(a: string | Buffer, b: string | Buffer, trace?: { iterations: number }): boolean {
    const bufA = typeof a === 'string' ? Buffer.from(a, 'utf-8') : Buffer.from(a);
    const bufB = typeof b === 'string' ? Buffer.from(b, 'utf-8') : Buffer.from(b);
    const n = Math.max(bufA.length, bufB.length);
    let diff = bufA.length ^ bufB.length;
    for (let i = 0; i < n; i += 1) {
      const byteA = i < bufA.length ? bufA[i] : 0;
      const byteB = i < bufB.length ? bufB[i] : 0;
      diff |= byteA ^ byteB;
    }
    if (trace) trace.iterations = n;
    return diff === 0;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 当前密钥版本号（密钥链长度） */
  private currentKeyVersion(): number {
    return this.keychain.length;
  }

  /** 当前工作密钥 */
  private currentKey(): Buffer {
    return this.keychain[this.keychain.length - 1]!;
  }

  /** 按版本号取密钥 */
  private getKeyByVersion(version: number): Buffer {
    const key = this.keychain[version - 1];
    if (!key) {
      throw new CryptoError(`密钥版本 ${version} 不存在于密钥链中（可能已轮换且未保留旧密钥）`, {
        keyVersion: version,
        chainLength: this.keychain.length,
      });
    }
    return key;
  }

  /** scrypt 派生工作密钥 */
  private deriveKey(masterKey: string): Buffer {
    return deriveWorkingKey(masterKey);
  }

  /** 字符串 → EncryptedField */
  private encryptStringToField(text: string): EncryptedField {
    const { ciphertext, iv, tag } = this.encryptRaw(text, this.currentKey());
    return {
      __encrypted: true,
      algorithm: this.config.algorithm,
      iv,
      tag,
      ciphertext,
      keyVersion: this.currentKeyVersion(),
    };
  }

  /** 底层加密原语（引擎配置算法口径） */
  private encryptRaw(
    plaintext: string,
    key: Buffer,
  ): { ciphertext: string; iv: string; tag?: string } {
    return this.encryptRawWith(plaintext, key, this.config.algorithm);
  }

  /** 底层加密原语（显式算法口径——分级密钥按级算法强度使用） */
  private encryptRawWith(
    plaintext: string,
    key: Buffer,
    algorithm: 'aes-256-gcm' | 'aes-256-cbc',
  ): { ciphertext: string; iv: string; tag?: string } {
    const isGcm = algorithm === 'aes-256-gcm';
    const iv = crypto.randomBytes(isGcm ? GCM_IV_LENGTH : CBC_IV_LENGTH);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let ciphertext = cipher.update(plaintext, 'utf-8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = isGcm ? (cipher as crypto.CipherGCM).getAuthTag().toString('hex') : undefined;
    return { ciphertext, iv: iv.toString('hex'), tag };
  }

  /** 底层解密原语 */
  private decryptRaw(
    data: { ciphertext: string; iv: string; tag?: string },
    key: Buffer,
    algorithm: EncryptionConfig['algorithm'],
  ): string {
    try {
      const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(data.iv, 'hex'));
      if (algorithm === 'aes-256-gcm') {
        if (!data.tag) {
          throw new CryptoError('GCM 密文缺少认证标签 tag');
        }
        (decipher as crypto.DecipherGCM).setAuthTag(Buffer.from(data.tag, 'hex'));
      }
      let plain = decipher.update(data.ciphertext, 'hex', 'utf-8');
      plain += decipher.final('utf-8');
      return plain;
    } catch (err) {
      if (err instanceof CryptoError) throw err;
      throw new CryptoError('解密失败：密钥不匹配或数据已被篡改');
    }
  }

  /** 原子写入：先写临时文件再 rename，防止半写损坏 */
  private atomicWrite(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
}
