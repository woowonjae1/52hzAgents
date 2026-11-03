'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { probeClients, ADAPTERS, locateBinary } = require('../capabilities');
const { parseJsonc, parseTomlDocument } = require('./formats');
const {
  buildPiSources,
  inspectPiConfig,
  listPiResources,
  validateAndBuildPiPatch,
} = require('./pi');
const {
  buildCodexSources,
  inspectCodexConfig,
  listCodexResources,
  validateAndBuildCodexPatch,
} = require('./codex');

const fail = (message, code = 'CONFIG_ERROR', status = 400, extra = {}) =>
  Object.assign(new Error(message), { code, status, ...extra });

const CANDIDATE_KIND_MAP = Object.freeze({
  'pi-native': 'native-pi',
  codex: 'native-codex',
  antigravity: 'native-antigravity',
  openclaw: 'native-openclaw',
  hermes: 'native-hermes',
});

const REVERSE_KIND_MAP = Object.freeze({
  'native-pi': 'pi-native',
  'native-codex': 'codex',
  'native-antigravity': 'antigravity',
  'native-openclaw': 'openclaw',
  'native-hermes': 'hermes',
});

function sha256Hex(bufferOrString) {
  return crypto.createHash('sha256').update(bufferOrString).digest('hex');
}

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function defaultConfigDirFor(kind, env = process.env) {
  if (kind === 'native-pi') {
    return env.PI_CODING_AGENT_DIR || path.join(homeDir(env), '.pi', 'agent');
  }
  if (kind === 'native-codex') {
    return env.CODEX_HOME || path.join(homeDir(env), '.codex');
  }
  if (kind === 'native-antigravity') {
    return path.join(homeDir(env), '.gemini', 'antigravity-cli');
  }
  return null;
}

/**
 * Resolve a directory path safely, rejecting symlinks along existing segments.
 */
function canonicalizeConfigDir(inputDir) {
  if (typeof inputDir !== 'string' || !inputDir.trim() || inputDir.includes('\0')) {
    throw fail('无效的配置目录路径。', 'INVALID_CONFIG_DIR', 400);
  }
  const resolved = path.resolve(inputDir.trim());
  const parts = [];
  let cur = resolved;
  while (true) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        throw fail('配置目录不允许使用符号链接或重解析点。', 'CONFIG_SYMLINK_REJECTED', 400);
      }
      if (!st.isDirectory()) {
        throw fail('配置路径不是目录。', 'INVALID_CONFIG_DIR', 400);
      }
      const realBase = fs.realpathSync.native(cur);
      return parts.length ? path.join(realBase, ...parts.reverse()) : realBase;
    } catch (err) {
      if (err.code === 'CONFIG_SYMLINK_REJECTED' || err.code === 'INVALID_CONFIG_DIR') throw err;
      if (err.code !== 'ENOENT') {
        throw fail(`无法访问配置目录: ${err.message}`, 'INVALID_CONFIG_DIR', 400);
      }
      const parent = path.dirname(cur);
      if (parent === cur) throw fail('无效的配置根目录。', 'INVALID_CONFIG_DIR', 400);
      parts.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Read a registered config file safely, checking for symlink substitution before reading.
 */

function encryptProtectedBackup(rawBuffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(rawBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const magic = Buffer.from('52HZ_PROTECTED_BAK_V1:');
  return Buffer.concat([magic, iv, tag, enc]);
}

function decryptProtectedBackup(backupBuffer, key) {
  const magic = Buffer.from('52HZ_PROTECTED_BAK_V1:');
  if (backupBuffer.length >= magic.length + 12 + 16 && backupBuffer.subarray(0, magic.length).equals(magic)) {
    const iv = backupBuffer.subarray(magic.length, magic.length + 12);
    const tag = backupBuffer.subarray(magic.length + 12, magic.length + 28);
    const enc = backupBuffer.subarray(magic.length + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
  return backupBuffer;
}

function assertPathWithinTrustedBase(targetPath, trustedBaseDir) {
  if (!trustedBaseDir) return;
  const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  const resolvedBase = path.resolve(trustedBaseDir);
  const resolvedTarget = path.resolve(targetPath);

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw fail('配置路径超出注册的可信配置目录边界。', 'CONFIG_OUT_OF_BOUNDS', 403);
  }

  // 向上追溯检查所有父祖先组件直到磁盘根目录（如 C:\ 或 /），全程绝不提前 break
  let cur = path.dirname(resolvedTarget);
  while (true) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        throw fail(`配置路径或其祖先目录被替换为符号链接或重解析点: ${cur}`, 'CONFIG_SYMLINK_REJECTED', 409);
      }
      if (process.platform === 'win32') {
        const nativeReal = fs.realpathSync.native(cur);
        if (norm(nativeReal) !== norm(cur)) {
          throw fail(`配置路径或其祖先目录存在重解析点/Junction: ${cur}`, 'CONFIG_SYMLINK_REJECTED', 409);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 与注册时锁定的可信基准路径比对，严禁现场重新解析 resolvedBase 造成同源绕过
  try {
    const realParent = fs.realpathSync.native(path.dirname(resolvedTarget));
    const relDir = path.dirname(rel);
    const expectedPhysicalDir = relDir === '.' ? resolvedBase : path.join(resolvedBase, relDir);
    if (norm(realParent) !== norm(expectedPhysicalDir)) {
      throw fail('配置文件父目录发生重解析偏移（实际物理路径与注册的可信根边界不符），已拒绝访问。', 'CONFIG_SYMLINK_REJECTED', 409);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function readSafeFileSnapshot(source, trustedBaseDir = null) {
  const target = source.canonicalPath;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw fail(`配置文件 ${source.sourceKey} 被替换为符号链接，已拒绝访问。`, 'CONFIG_SYMLINK_REJECTED', 409);
    }
    if (!st.isFile()) {
      throw fail(`配置路径 ${source.sourceKey} 不是普通文件。`, 'CONFIG_INVALID_FILE', 409);
    }
    const effectiveBase = trustedBaseDir || source.trustedBaseDir || source.canonicalConfigDir || null;
    if (effectiveBase) {
      assertPathWithinTrustedBase(target, effectiveBase);
    } else {
      const realParent = fs.realpathSync.native(path.dirname(target));
      const expectedParent = canonicalizeConfigDir(path.dirname(target));
      const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
      if (norm(realParent) !== norm(expectedParent)) {
        throw fail(`配置文件 ${source.sourceKey} 父目录发生重解析偏移，已拒绝访问。`, 'CONFIG_SYMLINK_REJECTED', 409);
      }
    }
    const rawBuffer = fs.readFileSync(target);
    const rawText = rawBuffer.toString('utf8');
    const sha256 = sha256Hex(rawBuffer);
    return {
      sourceKey: source.sourceKey,
      canonicalPath: target,
      exists: true,
      rawBuffer,
      rawText,
      sha256,
      mode: st.mode,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        sourceKey: source.sourceKey,
        canonicalPath: target,
        exists: false,
        rawBuffer: null,
        rawText: '',
        sha256: null,
        mode: 0o600,
      };
    }
    throw err;
  }
}

function writeFileAtomically(targetPath, contentBuffer, { mode = 0o600, expectedOldSha256, expectedOldExisted, sourceKey } = {}) {
  const dir = path.dirname(targetPath);
  const canonicalDir = canonicalizeConfigDir(dir);
  fs.mkdirSync(canonicalDir, { recursive: true });
  try {
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      throw fail('拒绝通过符号链接写入配置文件。', 'CONFIG_SYMLINK_REJECTED', 409);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmpName = `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(canonicalDir, tmpName);
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w', mode);
    fs.writeFileSync(fd, contentBuffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // CAS Check at the exact atomic replacement boundary:
    // Verify target file on disk right before renameSync replaces it.
    if (expectedOldSha256 !== undefined) {
      let curExists = false;
      let curSha = null;
      try {
        const stNow = fs.lstatSync(targetPath);
        if (stNow.isSymbolicLink()) {
          throw fail(`配置文件 ${sourceKey || path.basename(targetPath)} 在写入前被替换为符号链接。`, 'CONFIG_CONFLICT', 409);
        }
        if (stNow.isFile()) {
          curExists = true;
          curSha = sha256Hex(fs.readFileSync(targetPath));
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (curExists !== expectedOldExisted || curSha !== expectedOldSha256) {
        throw fail(
          `配置文件 ${sourceKey || path.basename(targetPath)} 在写入替换前已被外部修改（版本哈希不匹配），已阻止覆盖。`,
          'CONFIG_CONFLICT',
          409
        );
      }
    }

    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null && fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function restrictFilePermissions(filePath) {
  if (typeof restrictFilePermissions._mockHook === 'function') {
    try {
      restrictFilePermissions._mockHook(filePath);
      return;
    } catch (err) {
      throw fail(`设置受限 Windows 文件权限 (icacls) 失败: ${err.message}`, 'FILE_PERMISSIONS_FAILED', 500);
    }
  }
  if (process.platform === 'win32') {
    const username = process.env.USERNAME || process.env.USER;
    if (!username) {
      throw fail(
        '无法获取当前 Windows 用户名 (USERNAME/USER 环境变量缺失)，无法配置受限 ACL 权限。',
        'FILE_PERMISSIONS_FAILED',
        500
      );
    }
    const { execFileSync } = require('node:child_process');
    try {
      const isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
      const perms = isDir ? `${username}:(OI)(CI)(F)` : `${username}:(R,W)`;
      execFileSync('icacls.exe', [filePath, '/inheritance:r', '/grant:r', perms], {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (err) {
      throw fail(
        `设置受限 Windows 文件权限 (icacls) 失败: ${err.message}`,
        'FILE_PERMISSIONS_FAILED',
        500
      );
    }
  } else {
    try {
      const isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
      fs.chmodSync(filePath, isDir ? 0o700 : 0o600);
    } catch (err) {
      throw fail(
        `设置受限 POSIX 文件权限 (chmod) 失败: ${err.message}`,
        'FILE_PERMISSIONS_FAILED',
        500
      );
    }
  }
}

function writeProtectedVaultFile(targetPath, dataBuffer) {
  const tmpPath = targetPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, dataBuffer, { mode: 0o600 });
    restrictFilePermissions(tmpPath);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function writeProtectedVaultFileExclusive(targetPath, dataBuffer) {
  if (fs.existsSync(targetPath)) {
    const err = new Error(`Target file already exists: ${targetPath}`);
    err.code = 'EEXIST';
    throw err;
  }
  const uniqueTmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd = null;
  let ownsTemp = false;
  try {
    fd = fs.openSync(uniqueTmpPath, 'wx', 0o600);
    ownsTemp = true;
    fs.writeFileSync(fd, dataBuffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    restrictFilePermissions(uniqueTmpPath);

    try {
      // Publish only a complete, flushed, ACL-protected file. Hard-link creation
      // fails atomically if a winner already exists; direct 'wx' writes would
      // expose an empty/partial final file before write and permission checks.
      fs.linkSync(uniqueTmpPath, targetPath);
    } catch (linkErr) {
      if (linkErr.code === 'EEXIST') throw linkErr;
      throw fail(
        `无法安全发布备份保护密钥 (${linkErr.code || linkErr.message})。请确认数据目录所在文件系统支持硬链接且有写入权限；未创建或覆盖正式密钥文件。`,
        'VAULT_ATOMIC_PUBLISH_FAILED',
        500,
        { cause: linkErr }
      );
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (ownsTemp) {
      try { fs.unlinkSync(uniqueTmpPath); } catch {}
    }
  }
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    // EPERM 等错误表明该进程存在于系统中，仍属于存活进程
    return true;
  }
}

function readLockFileSafe(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createMockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from('MOCK_SAFE:' + Buffer.from(str).toString('hex')),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('MOCK_SAFE:')) throw new Error('Decryption failed');
      return Buffer.from(s.slice('MOCK_SAFE:'.length), 'hex').toString('utf8');
    },
  };
}

async function withVaultInitLock(vaultDir, fn) {
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  restrictFilePermissions(vaultDir);
  const lockFile = path.join(vaultDir, 'backup_protection.lock');
  const ownerToken = `owner-${process.pid}-${crypto.randomUUID()}`;
  const startTime = Date.now();
  const timeout = 10000;
  let lockFd = null;

  while (!lockFd) {
    let candidateFd = null;
    try {
      candidateFd = fs.openSync(lockFile, 'wx');
      const lockPayload = JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt: Date.now(),
      });
      fs.writeSync(candidateFd, Buffer.from(lockPayload, 'utf8'));
      fs.fsyncSync(candidateFd);
      lockFd = candidateFd;
    } catch (err) {
      if (candidateFd !== null) {
        try { fs.closeSync(candidateFd); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          const current = readLockFileSafe(lockFile);

          if (current && current.pid) {
            const isAlive = isProcessAlive(current.pid);
            if (!isAlive) {
              // 仅当持锁进程确认已退出/死亡 (!isAlive) 且超时大于 15 秒时，才允许回收僵尸锁
              if (Date.now() - stat.mtimeMs > 15000) {
                const recheck = readLockFileSafe(lockFile);
                if (recheck && recheck.ownerToken === current.ownerToken && recheck.pid === current.pid) {
                  try { fs.unlinkSync(lockFile); } catch {}
                }
              }
            }
            // 若持锁进程仍然活着，即便模拟修改 mtime 过期，也绝对禁止抢占和删除锁
          } else {
            // 锁文件为空或无法解析，且文件时间已超过 15 秒，才作为无主损坏残留清理
            if (Date.now() - stat.mtimeMs > 15000) {
              try { fs.unlinkSync(lockFile); } catch {}
            }
          }
        } catch {}

        if (Date.now() - startTime > timeout) {
          throw fail('等待配置保护密钥初始化锁超时。', 'VAULT_LOCK_TIMEOUT', 500);
        }
        await new Promise(r => setTimeout(r, 20));
        continue;
      }
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (lockFd !== null) fs.closeSync(lockFd);
    } catch {}
    // 释放锁时校验所有者身份，禁止误删其他实例的锁
    try {
      const current = readLockFileSafe(lockFile);
      if (current && current.ownerToken === ownerToken && current.pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    } catch {}
  }
}

function withVaultInitLockSync(vaultDir, fn) {
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  restrictFilePermissions(vaultDir);
  const lockFile = path.join(vaultDir, 'backup_protection.lock');
  const ownerToken = `owner-${process.pid}-${crypto.randomUUID()}`;
  const startTime = Date.now();
  const timeout = 10000;
  let lockFd = null;

  while (!lockFd) {
    let candidateFd = null;
    try {
      candidateFd = fs.openSync(lockFile, 'wx');
      const lockPayload = JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt: Date.now(),
      });
      fs.writeSync(candidateFd, Buffer.from(lockPayload, 'utf8'));
      fs.fsyncSync(candidateFd);
      lockFd = candidateFd;
    } catch (err) {
      if (candidateFd !== null) {
        try { fs.closeSync(candidateFd); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          const current = readLockFileSafe(lockFile);

          if (current && current.pid) {
            const isAlive = isProcessAlive(current.pid);
            if (!isAlive) {
              // 仅当持锁进程确认已退出/死亡 (!isAlive) 且超时大于 15 秒时，才允许回收僵尸锁
              if (Date.now() - stat.mtimeMs > 15000) {
                const recheck = readLockFileSafe(lockFile);
                if (recheck && recheck.ownerToken === current.ownerToken && recheck.pid === current.pid) {
                  try { fs.unlinkSync(lockFile); } catch {}
                }
              }
            }
            // 若持锁进程仍然活着，即便模拟修改 mtime 过期，也绝对禁止抢占和删除锁
          } else {
            // 锁文件为空或无法解析，且文件时间已超过 15 秒，才作为无主损坏残留清理
            if (Date.now() - stat.mtimeMs > 15000) {
              try { fs.unlinkSync(lockFile); } catch {}
            }
          }
        } catch {}

        if (Date.now() - startTime > timeout) {
          throw fail('等待配置保护密钥初始化锁超时。', 'VAULT_LOCK_TIMEOUT', 500);
        }
        const sleepUntil = Date.now() + 20;
        while (Date.now() < sleepUntil) {}
        continue;
      }
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    try {
      if (lockFd !== null) fs.closeSync(lockFd);
    } catch {}
    // 释放锁时校验所有者身份，禁止误删其他实例的锁
    try {
      const current = readLockFileSafe(lockFile);
      if (current && current.ownerToken === ownerToken && current.pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    } catch {}
  }
}

class NativeConfigService {
  /**
   * @param {{ storage: import('../../storage').Storage, userDataPath: string, runner?: any, env?: NodeJS.ProcessEnv, safeStorage?: any }} opts
   */
  constructor({ storage, userDataPath, runner = null, env = process.env, safeStorage = null }) {
    this.storage = storage;
    this.userDataPath = userDataPath;
    this.runner = runner;
    this.env = env;
    this.safeStorage = safeStorage;
    if (!this.safeStorage) {
      try {
        const electron = require('electron');
        if (electron?.safeStorage?.isEncryptionAvailable?.()) {
          this.safeStorage = electron.safeStorage;
        }
      } catch (_) {}
    }
    this.backupsRoot = path.join(userDataPath, 'native-config-backups');
    this.locks = new Set();
    this._ensureBackupCipherKeyPromise = null;
  }

  async init() {
    try {
      await this.ensureBackupCipherKey();
    } catch (err) {
      if (err.code !== 'SAFE_STORAGE_UNAVAILABLE') {
        throw err;
      }
    }
    return this;
  }

  _readOrMigrateExistingKeyFileSync(keyFile) {
    let raw;
    try {
      raw = fs.readFileSync(keyFile);
    } catch (err) {
      throw fail(
        `无法读取备份保护密钥文件 (${err.message})。为防止已有配置备份失效，已阻止配置操作。`,
        'BACKUP_KEY_READ_FAILED',
        500
      );
    }

    const safePrefix = 'SAFE_STORAGE_V1:';
    if (raw.subarray(0, safePrefix.length).toString('utf8') === safePrefix) {
      if (!this.safeStorage || typeof this.safeStorage.decryptString !== 'function' ||
          (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
        throw fail(
          '备份保护密钥由系统凭据 (safeStorage) 加密，但当前环境凭据加密不可用，已阻止继续执行配置变更以保护历史备份。',
          'SAFE_STORAGE_UNAVAILABLE',
          503
        );
      }
      let decryptedBase64;
      try {
        const cipherBuffer = raw.subarray(safePrefix.length);
        decryptedBase64 = this.safeStorage.decryptString(cipherBuffer);
      } catch (decryptErr) {
        throw fail(
          `备份保护密钥解密失败 (${decryptErr.message})。原损坏密钥已保留在 ${keyFile}，已阻止配置操作以保护历史备份。请使用备份恢复凭据恢复。`,
          'BACKUP_KEY_CORRUPTED',
          500
        );
      }
      const keyBuf = Buffer.from(decryptedBase64, 'base64');
      if (keyBuf.length !== 32) {
        throw fail(
          `备份保护密钥解密后长度无效 (${keyBuf.length} 字节)。原密钥文件已保留，已阻止配置操作。`,
          'BACKUP_KEY_CORRUPTED',
          500
        );
      }
      this._cachedBackupCipherKey = keyBuf;
      return keyBuf;
    }

    // 兼容历史裸密钥格式 (RAW_KEY_V1: 或 32 字节裸 key)
    const rawPrefix = 'RAW_KEY_V1:';
    let candidateKey = null;
    if (raw.subarray(0, rawPrefix.length).toString('utf8') === rawPrefix) {
      candidateKey = raw.subarray(rawPrefix.length);
    } else if (raw.length === 32) {
      candidateKey = raw;
    }

    if (candidateKey) {
      if (candidateKey.length !== 32) {
        throw fail(
          `备份保护密钥文件损坏 (${candidateKey.length} 字节)。原密钥文件已保留在 ${keyFile}，已阻止配置操作以保护历史备份。`,
          'BACKUP_KEY_CORRUPTED',
          500
        );
      }

      // 绝不返回明文裸密钥！若 safeStorage 不可用，严格拒绝使用
      if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' ||
          (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
        throw fail(
          '检测到历史未受保护的备份密钥，但当前环境系统凭据保护服务 (safeStorage) 不可用，无法执行加密迁移，已拒绝使用裸密钥。',
          'SAFE_STORAGE_UNAVAILABLE',
          503
        );
      }

      // 仅在成功加密迁移并设置 ACL 替换原文件后继续使用
      let encBuffer;
      try {
        encBuffer = this.safeStorage.encryptString(candidateKey.toString('base64'));
      } catch (encErr) {
        throw fail(
          `历史明文备份密钥加密迁移至 safeStorage 失败 (${encErr.message})。原密钥文件已保留，已阻止配置操作。`,
          'BACKUP_KEY_MIGRATION_FAILED',
          500
        );
      }

      const migratedPayload = Buffer.concat([Buffer.from(safePrefix, 'utf8'), encBuffer]);
      writeProtectedVaultFile(keyFile, migratedPayload);

      this._cachedBackupCipherKey = candidateKey;
      return candidateKey;
    }

    // 文件存在但不符合任何已知有效密钥格式（损坏）
    throw fail(
      `备份保护密钥文件格式损坏或长度不正确。原损坏密钥文件已保留在 ${keyFile}，已阻止配置操作以保护历史备份。请使用备份恢复凭据恢复。`,
      'BACKUP_KEY_CORRUPTED',
      500
    );
  }

  async _readOrMigrateExistingKeyFileAsync(keyFile) {
    let raw;
    try {
      raw = fs.readFileSync(keyFile);
    } catch (err) {
      throw fail(
        `无法读取备份保护密钥文件 (${err.message})。为防止已有配置备份失效，已阻止配置操作。`,
        'BACKUP_KEY_READ_FAILED',
        500
      );
    }

    const safePrefix = 'SAFE_STORAGE_V1:';
    if (raw.subarray(0, safePrefix.length).toString('utf8') === safePrefix) {
      if (!this.safeStorage || typeof this.safeStorage.decryptString !== 'function' ||
          (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
        throw fail(
          '备份保护密钥由系统凭据 (safeStorage) 加密，但当前环境凭据加密不可用，已阻止继续执行配置变更以保护历史备份。',
          'SAFE_STORAGE_UNAVAILABLE',
          503
        );
      }
      let decryptedBase64;
      try {
        const cipherBuffer = raw.subarray(safePrefix.length);
        decryptedBase64 = await Promise.resolve(this.safeStorage.decryptString(cipherBuffer));
      } catch (decryptErr) {
        throw fail(
          `备份保护密钥解密失败 (${decryptErr.message})。原损坏密钥已保留在 ${keyFile}，已阻止配置操作以保护历史备份。请使用备份恢复凭据恢复。`,
          'BACKUP_KEY_CORRUPTED',
          500
        );
      }
      const keyBuf = Buffer.from(decryptedBase64, 'base64');
      if (keyBuf.length !== 32) {
        throw fail(
          `备份保护密钥解密后长度无效 (${keyBuf.length} 字节)。原密钥文件已保留，已阻止配置操作。`,
          'BACKUP_KEY_CORRUPTED',
          500
        );
      }
      this._cachedBackupCipherKey = keyBuf;
      return keyBuf;
    }

    // 兼容历史裸密钥格式 (RAW_KEY_V1: 或 32 字节裸 key)
    const rawPrefix = 'RAW_KEY_V1:';
    let candidateKey = null;
    if (raw.subarray(0, rawPrefix.length).toString('utf8') === rawPrefix) {
      candidateKey = raw.subarray(rawPrefix.length);
    } else if (raw.length === 32) {
      candidateKey = raw;
    }

    if (candidateKey) {
      if (candidateKey.length !== 32) {
        throw fail(
          `备份保护密钥文件损坏 (${candidateKey.length} 字节)。原密钥文件已保留在 ${keyFile}，已阻止配置操作以保护历史备份。`,
          'BACKUP_KEY_CORRUPTED',
          500
        );
      }

      // 绝不返回明文裸密钥！若 safeStorage 不可用，严格拒绝使用
      if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' ||
          (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
        throw fail(
          '检测到历史未受保护的备份密钥，但当前环境系统凭据保护服务 (safeStorage) 不可用，无法执行加密迁移，已拒绝使用裸密钥。',
          'SAFE_STORAGE_UNAVAILABLE',
          503
        );
      }

      // 仅在成功加密迁移并设置 ACL 替换原文件后继续使用
      let encBuffer;
      try {
        encBuffer = await Promise.resolve(this.safeStorage.encryptString(candidateKey.toString('base64')));
      } catch (encErr) {
        throw fail(
          `历史明文备份密钥加密迁移至 safeStorage 失败 (${encErr.message})。原密钥文件已保留，已阻止配置操作。`,
          'BACKUP_KEY_MIGRATION_FAILED',
          500
        );
      }

      const migratedPayload = Buffer.concat([Buffer.from(safePrefix, 'utf8'), encBuffer]);
      writeProtectedVaultFile(keyFile, migratedPayload);

      this._cachedBackupCipherKey = candidateKey;
      return candidateKey;
    }

    // 文件存在但不符合任何已知有效密钥格式（损坏）
    throw fail(
      `备份保护密钥文件格式损坏或长度不正确。原损坏密钥文件已保留在 ${keyFile}，已阻止配置操作以保护历史备份。请使用备份恢复凭据恢复。`,
      'BACKUP_KEY_CORRUPTED',
      500
    );
  }

  _createAndSaveFreshKeySync(vaultDir, keyFile) {
    if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' ||
        (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
      throw fail(
        '系统凭据保护服务 (safeStorage) 不可用，已拒绝以明文方式生成配置备份保护密钥。',
        'SAFE_STORAGE_UNAVAILABLE',
        503
      );
    }

    const freshKey = crypto.randomBytes(32);
    const recoveryToken = 'BAK-REC-' + crypto.randomBytes(16).toString('hex').toUpperCase();

    let cipherBuffer;
    try {
      cipherBuffer = this.safeStorage.encryptString(freshKey.toString('base64'));
    } catch (safeErr) {
      throw fail(`通过系统凭据服务保护备份密钥失败: ${safeErr.message}`, 'BACKUP_KEY_SAVE_FAILED', 500);
    }

    const filePayload = Buffer.concat([Buffer.from('SAFE_STORAGE_V1:', 'utf8'), cipherBuffer]);
    const cipherScheme = 'electron-safe-storage-dpapi';
    const metaFile = path.join(vaultDir, 'backup_protection_meta.json');

    try {
      writeProtectedVaultFileExclusive(keyFile, filePayload);
      writeProtectedVaultFile(
        metaFile,
        Buffer.from(
          JSON.stringify(
            {
              createdAt: new Date().toISOString(),
              algorithm: 'aes-256-gcm',
              cipherScheme,
              recoveryTokenHash: crypto.createHash('sha256').update(recoveryToken).digest('hex'),
            },
            null,
            2
          ),
          'utf8'
        )
      );
    } catch (saveErr) {
      if (saveErr.code === 'EEXIST') {
        // 关键收敛点：若目标文件已存在（排他落盘拒绝覆盖），说明已有并发胜出者成功生成密钥
        // 严禁覆盖胜出者密钥，直接读取并解密胜出者密钥并收敛本地缓存
        return this._readOrMigrateExistingKeyFileSync(keyFile);
      }
      if (saveErr.code === 'FILE_PERMISSIONS_FAILED') throw saveErr;
      throw fail(`无法保存备份保护密钥文件 (${saveErr.message})，已阻止配置操作。`, 'BACKUP_KEY_SAVE_FAILED', 500);
    }

    this._cachedBackupCipherKey = freshKey;
    this._backupRecoveryToken = recoveryToken;
    return freshKey;
  }

  async _createAndSaveFreshKeyAsync(vaultDir, keyFile) {
    if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' ||
        (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
      throw fail(
        '系统凭据保护服务 (safeStorage) 不可用，已拒绝以明文方式生成配置备份保护密钥。',
        'SAFE_STORAGE_UNAVAILABLE',
        503
      );
    }

    const freshKey = crypto.randomBytes(32);
    const recoveryToken = 'BAK-REC-' + crypto.randomBytes(16).toString('hex').toUpperCase();

    let cipherBuffer;
    try {
      cipherBuffer = await Promise.resolve(this.safeStorage.encryptString(freshKey.toString('base64')));
    } catch (safeErr) {
      throw fail(`通过系统凭据服务保护备份密钥失败: ${safeErr.message}`, 'BACKUP_KEY_SAVE_FAILED', 500);
    }

    const filePayload = Buffer.concat([Buffer.from('SAFE_STORAGE_V1:', 'utf8'), cipherBuffer]);
    const cipherScheme = 'electron-safe-storage-dpapi';
    const metaFile = path.join(vaultDir, 'backup_protection_meta.json');

    try {
      writeProtectedVaultFileExclusive(keyFile, filePayload);
      writeProtectedVaultFile(
        metaFile,
        Buffer.from(
          JSON.stringify(
            {
              createdAt: new Date().toISOString(),
              algorithm: 'aes-256-gcm',
              cipherScheme,
              recoveryTokenHash: crypto.createHash('sha256').update(recoveryToken).digest('hex'),
            },
            null,
            2
          ),
          'utf8'
        )
      );
    } catch (saveErr) {
      if (saveErr.code === 'EEXIST') {
        // 关键收敛点：若目标文件已存在（排他落盘拒绝覆盖），说明已有并发胜出者成功生成密钥
        // 严禁覆盖胜出者密钥，直接读取并解密胜出者密钥并收敛本地缓存
        return await this._readOrMigrateExistingKeyFileAsync(keyFile);
      }
      if (saveErr.code === 'FILE_PERMISSIONS_FAILED') throw saveErr;
      throw fail(`无法保存备份保护密钥文件 (${saveErr.message})，已阻止配置操作。`, 'BACKUP_KEY_SAVE_FAILED', 500);
    }

    this._cachedBackupCipherKey = freshKey;
    this._backupRecoveryToken = recoveryToken;
    return freshKey;
  }

  async ensureBackupCipherKey() {
    if (this._cachedBackupCipherKey) return this._cachedBackupCipherKey;
    // 实例内并发保护：复用同一个初始化 Promise，防止多次调用生成不同密钥
    if (this._ensureBackupCipherKeyPromise) return this._ensureBackupCipherKeyPromise;

    this._ensureBackupCipherKeyPromise = (async () => {
      try {
        const vaultDir = path.join(this.userDataPath, '.vault');
        const keyFile = path.join(vaultDir, 'backup_protection.key');

        // 快路径：如果密钥文件已存在，直接读取校验/解密
        if (fs.existsSync(keyFile)) {
          return await this._readOrMigrateExistingKeyFileAsync(keyFile);
        }

        // 跨实例排他创建锁：确保并发创建时只有一个胜出者，胜出后其他实例读取已有文件，禁止覆盖
        return await withVaultInitLock(vaultDir, async () => {
          // 双重检查：排队获得锁后再次检查 keyFile 是否已被前序胜出者生成
          if (fs.existsSync(keyFile)) {
            return await this._readOrMigrateExistingKeyFileAsync(keyFile);
          }
          return await this._createAndSaveFreshKeyAsync(vaultDir, keyFile);
        });
      } finally {
        this._ensureBackupCipherKeyPromise = null;
      }
    })();

    return this._ensureBackupCipherKeyPromise;
  }

  get backupCipherKey() {
    if (this._cachedBackupCipherKey) return this._cachedBackupCipherKey;

    if (this.safeStorage?.isBridge) {
      throw fail(
        '备份密钥尚未在子进程中初始化，请先调用 await service.ensureBackupCipherKey()',
        'BACKUP_KEY_NOT_INITIALIZED',
        500
      );
    }

    const vaultDir = path.join(this.userDataPath, '.vault');
    const keyFile = path.join(vaultDir, 'backup_protection.key');

    if (fs.existsSync(keyFile)) {
      return this._readOrMigrateExistingKeyFileSync(keyFile);
    }

    return withVaultInitLockSync(vaultDir, () => {
      if (fs.existsSync(keyFile)) {
        return this._readOrMigrateExistingKeyFileSync(keyFile);
      }
      return this._createAndSaveFreshKeySync(vaultDir, keyFile);
    });
  }

  restoreBackupCipherKey(keyBuffer) {
    if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
      throw fail('恢复密钥必须是 32 字节二进制凭据。', 'INVALID_RECOVERY_KEY', 400);
    }
    // 绝不落明文：无 safeStorage 时拒绝恢复
    if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' ||
        (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
      throw fail(
        '系统凭据保护服务 (safeStorage) 不可用，已拒绝以明文方式恢复配置备份保护密钥。',
        'SAFE_STORAGE_UNAVAILABLE',
        503
      );
    }

    const vaultDir = path.join(this.userDataPath, '.vault');
    const keyFile = path.join(vaultDir, 'backup_protection.key');

    const cipher = this.safeStorage.encryptString(keyBuffer.toString('base64'));
    if (cipher && typeof cipher.then === 'function') {
      return (async () => {
        const cipherBuf = await cipher;
        const filePayload = Buffer.concat([Buffer.from('SAFE_STORAGE_V1:', 'utf8'), cipherBuf]);
        await withVaultInitLock(vaultDir, async () => {
          writeProtectedVaultFile(keyFile, filePayload);
        });
        this._cachedBackupCipherKey = keyBuffer;
      })();
    }

    const filePayload = Buffer.concat([Buffer.from('SAFE_STORAGE_V1:', 'utf8'), cipher]);
    withVaultInitLockSync(vaultDir, () => {
      writeProtectedVaultFile(keyFile, filePayload);
    });
    this._cachedBackupCipherKey = keyBuffer;
  }

  get repo() {
    const r = this.storage?.agentConnections;
    if (!r) throw fail('Agent connections storage unavailable.', 'STORAGE_UNAVAILABLE', 503);
    return r;
  }

  assertRecoveryReady() {
    this.runner?.assertRecoveryReady?.();
  }

  activeRunCountForConnection(connectionId) {
    if (!this.runner?.active) return 0;
    let count = 0;
    for (const run of this.runner.active.values()) {
      if (run?.agentIdentity?.connectionId === connectionId) count++;
    }
    return count;
  }

  assertConnectionHealthyForExecution(connectionId) {
    if (!connectionId) return;
    const broken = this.repo.hasBrokenChangeState(connectionId);
    if (broken) {
      throw fail(
        `该 Agent 连接存在未恢复的配置写入故障 (${broken.id})。为避免在混合版本配置上运行，请先在设置中恢复或重试配置保存。`,
        'CONFIG_APPLY_INCOMPLETE',
        409
      );
    }
  }

  async discoverCandidates({ versions = false, env = this.env } = {}) {
    const probed = await probeClients({ env, versions });
    const existingConnections = this.repo.list({ includeDisabled: true });

    const candidates = [];
    for (const client of probed.clients) {
      if (client.kind === 'builtin-pi-sdk') continue;
      const connectionKind = CANDIDATE_KIND_MAP[client.kind] || null;
      const defaultConfigDir = connectionKind ? defaultConfigDirFor(connectionKind, env) : null;
      const registered = connectionKind
        ? existingConnections.filter(c => c.kind === connectionKind)
        : [];

      let configReadable = false;
      let authConfigured = false;
      if (connectionKind === 'native-pi' && defaultConfigDir) {
        try {
          const sources = buildPiSources(canonicalizeConfigDir(defaultConfigDir));
          const snaps = new Map(sources.map(s => [s.sourceKey, readSafeFileSnapshot(s)]));
          const inspected = inspectPiConfig(snaps, { env });
          configReadable = inspected.readiness.configReadable;
          authConfigured = inspected.readiness.anyAuthConfigured;
        } catch {
          configReadable = false;
        }
      } else if (connectionKind === 'native-codex' && defaultConfigDir) {
        try {
          const sources = buildCodexSources(canonicalizeConfigDir(defaultConfigDir));
          const snaps = new Map(sources.map(s => [s.sourceKey, readSafeFileSnapshot(s)]));
          const inspected = inspectCodexConfig(snaps, { env });
          configReadable = inspected.readiness.configReadable;
          authConfigured = inspected.readiness.authConfigured;
        } catch {
          configReadable = false;
        }
      } else {
        configReadable = client.configSources.some(s => s.exists);
      }

      candidates.push({
        candidateKind: connectionKind,
        probeKind: client.kind,
        name: client.name,
        stage: client.stage,
        stageNote: client.stageNote,
        canRegister: Boolean(connectionKind && client.stage !== 'deferred'),
        installation: client.installation,
        defaultConfigDir,
        configSources: client.configSources,
        configNote: client.configNote,
        capabilities: client.capabilities,
        statusBreakdown: {
          installationDetected: Boolean(client.installation.detected),
          configReadable,
          authConfigured,
          executionVerified: false,
        },
        registeredConnections: registered.map(c => ({
          id: c.id,
          displayName: c.displayName,
          configDir: c.configDir,
          sharedMembers: c.sharedMembers,
        })),
      });
    }

    return { probedAt: probed.probedAt, platform: probed.platform, candidates };
  }

  buildSourcesForConnection(kind, canonicalConfigDir) {
    if (!canonicalConfigDir) return [];
    if (kind === 'native-pi') return buildPiSources(canonicalConfigDir);
    if (kind === 'native-codex') return buildCodexSources(canonicalConfigDir);
    if (kind === 'native-antigravity') {
      return [
        {
          sourceKey: 'antigravity.settings',
          scope: 'global',
          format: 'json',
          canonicalPath: path.join(canonicalConfigDir, 'settings.json'),
          holdsSecret: false,
        },
      ];
    }
    return [];
  }

  resolveInstallationRef(kind, explicitPath = null) {
    const probeKind = REVERSE_KIND_MAP[kind];
    const adapter = ADAPTERS.find(a => a.kind === probeKind);
    if (!adapter) throw fail(`未知客户端类型: ${kind}`, 'INVALID_CONNECTION_KIND', 400);

    const located = locateBinary(adapter, this.env);
    if (located) return located.path;

    if (explicitPath && typeof explicitPath === 'string') {
      const candidate = path.resolve(explicitPath.trim());
      try {
        const st = fs.lstatSync(candidate);
        if (st.isFile() && !st.isSymbolicLink()) {
          return fs.realpathSync.native(candidate);
        }
      } catch {}
    }
    throw fail(`未在本机检测到 ${adapter.name} 可执行文件，无法注册连接。`, 'CLIENT_NOT_DETECTED', 400);
  }

  registerConnection(input = {}) {
    this.assertRecoveryReady();
    if (!input || typeof input !== 'object') throw fail('请求体必须是对象。');
    const kind = input.kind || input.adapterKind;
    if (!['native-pi', 'native-codex', 'native-antigravity', 'native-openclaw', 'native-hermes'].includes(kind)) {
      throw fail(`不支持的 Agent 连接类型: ${kind}`, 'INVALID_CONNECTION_KIND', 400);
    }

    const installationRef = this.resolveInstallationRef(kind, input.installationPath);
    const rawConfigDir = input.configDir || defaultConfigDirFor(kind, this.env);
    const canonicalConfigDir = rawConfigDir ? canonicalizeConfigDir(rawConfigDir) : null;

    // Prevent pointing configDir at the workbench's own database directory.
    if (canonicalConfigDir && this.userDataPath) {
      const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
      try {
        const realUserData = fs.realpathSync.native(this.userDataPath);
        if (norm(canonicalConfigDir) === norm(realUserData)) {
          throw fail('配置目录不能指向工作台自身的数据根目录。', 'INVALID_CONFIG_DIR', 400);
        }
      } catch (err) {
        if (err.code === 'INVALID_CONFIG_DIR') throw err;
      }
    }

    const rawSources = this.buildSourcesForConnection(kind, canonicalConfigDir);
    const sourcesWithHashes = rawSources.map(src => {
      const snap = readSafeFileSnapshot(src);
      return {
        ...src,
        contentSha256: snap.sha256,
      };
    });

    const probeKind = REVERSE_KIND_MAP[kind];
    const adapter = ADAPTERS.find(a => a.kind === probeKind);
    const displayName = (typeof input.displayName === 'string' && input.displayName.trim())
      ? input.displayName.trim()
      : (adapter?.name || kind);

    const connection = this.repo.create({
      kind,
      displayName,
      environment: input.environment || 'local',
      installationRef,
      configDir: canonicalConfigDir,
      nativeProfile: input.nativeProfile || null,
      capabilitySnapshot: {
        probeKind,
        stage: adapter?.stage || 'unknown',
        capabilities: adapter?.capabilities || {},
        probedAt: new Date().toISOString(),
      },
      sources: sourcesWithHashes,
    });

    let member = null;
    if (input.createMember !== false && this.storage?.agentDefinitions) {
      const memberName = (typeof input.memberName === 'string' && input.memberName.trim())
        ? input.memberName.trim()
        : displayName;
      member = this.storage.agentDefinitions.create({
        name: memberName,
        description: input.description || `关联本机 ${displayName} 原生配置与连接`,
        role: input.role || 'assistant',
        connectionId: connection.id,
        runtimeModel: input.runtimeModel || null,
        defaultMode: 'plan',
        maxMode: 'agent',
        permissions: {
          readFiles: true,
          writeFiles: true,
          executeCommands: true,
          mcp: false,
          delegate: false,
          knowledge: false,
        },
      });
    }

    return {
      connection: this.repo.get(connection.id),
      member,
    };
  }

  readSnapshotsForConnection(conn) {
    const snapshots = new Map();
    const trustedBase = conn.configDir || conn.canonicalConfigDir || null;
    for (const src of conn.sources || []) {
      const snap = readSafeFileSnapshot(src, trustedBase);
      snapshots.set(src.sourceKey, snap);
      if (src.contentSha256 !== snap.sha256) {
        this.repo.updateSourceHash(conn.id, src.sourceKey, snap.sha256);
      }
    }
    return snapshots;
  }

  inspectConfig(connectionId, { projectDir = null } = {}) {
    const conn = this.repo.requireRegistered(connectionId);
    const snapshots = this.readSnapshotsForConnection(conn);
    const broken = this.repo.hasBrokenChangeState(conn.id);

    let inspected;
    if (conn.kind === 'native-pi') {
      inspected = inspectPiConfig(snapshots, { projectDir, env: this.env });
    } else if (conn.kind === 'native-codex') {
      inspected = inspectCodexConfig(snapshots, { env: this.env });
    } else {
      inspected = {
        view: {},
        effective: {},
        readiness: {
          configReadable: [...snapshots.values()].some(s => s.exists),
          authConfigured: false,
        },
        editableFields: [],
        scopeWarning: '该客户端的配置读写适配尚未开启。',
      };
    }

    const refreshedConn = this.repo.get(conn.id);
    const versions = {};
    const sources = refreshedConn.sources.map(src => {
      const snap = snapshots.get(src.sourceKey);
      versions[src.sourceKey] = snap?.sha256 || null;
      return {
        ...src,
        exists: Boolean(snap?.exists),
        sha256: snap?.sha256 || null,
      };
    });

    return {
      connection: refreshedConn,
      sources,
      versions,
      brokenChangeState: broken,
      ...inspected,
      statusBreakdown: {
        installationDetected: true,
        configReadable: Boolean(inspected.readiness?.configReadable),
        authConfigured: Boolean(inspected.readiness?.authConfigured),
        executionVerified: false,
      },
      recentChanges: this.repo.listChanges(conn.id, { limit: 10 }),
    };
  }

  listResources(connectionId) {
    const conn = this.repo.requireRegistered(connectionId);
    const snapshots = this.readSnapshotsForConnection(conn);

    if (conn.kind === 'native-pi') {
      return {
        connection: conn,
        ...listPiResources(snapshots, { env: this.env }),
      };
    }
    if (conn.kind === 'native-codex') {
      return {
        connection: conn,
        ...listCodexResources(snapshots, { configDir: conn.configDir, env: this.env }),
      };
    }
    return {
      connection: conn,
      effective: {},
      readiness: { configReadable: false, authConfigured: false },
      providers: [],
      models: [],
      note: '该客户端的资源查询适配尚未开启。',
    };
  }

  buildValidatedPlan(conn, snapshots, patch) {
    if (conn.kind === 'native-pi') {
      return validateAndBuildPiPatch(snapshots, patch);
    }
    if (conn.kind === 'native-codex') {
      return validateAndBuildCodexPatch(snapshots, patch);
    }
    throw fail(`客户端类型 ${conn.kind} 暂不支持配置写入。`, 'CONFIG_WRITE_UNSUPPORTED', 409);
  }

  verifyExpectedVersions(snapshots, fileChanges, expectedVersions, { requireVersions = false } = {}) {
    if (requireVersions && (!expectedVersions || typeof expectedVersions !== 'object')) {
      throw fail('保存配置时必须提供 expectedVersions 版本摘要以防止并发覆盖。', 'CONFIG_VERSION_REQUIRED', 400);
    }
    if (!expectedVersions || typeof expectedVersions !== 'object') return;
    for (const fc of fileChanges) {
      if (!Object.prototype.hasOwnProperty.call(expectedVersions, fc.sourceKey)) {
        if (requireVersions) {
          throw fail(`缺少配置源 ${fc.sourceKey} 的预期版本摘要 (expectedVersions)。`, 'CONFIG_VERSION_REQUIRED', 400);
        }
        continue;
      }
      const expectedSha = expectedVersions[fc.sourceKey] || null;
      const currentSha = snapshots.get(fc.sourceKey)?.sha256 || null;
      if (expectedSha !== currentSha) {
        throw fail(
          `配置文件 ${fc.sourceKey} 已在外部被修改（预期版本 ${expectedSha || '不存在'}，当前版本 ${currentSha || '不存在'}）。请重新加载后再合并修改。`,
          'CONFIG_CONFLICT',
          409,
          {
            sourceKey: fc.sourceKey,
            expectedSha256: expectedSha,
            currentSha256: currentSha,
          }
        );
      }
    }
  }

  prepareConfigChange(connectionId, { patch, expectedVersions } = {}) {
    const conn = this.repo.requireRegistered(connectionId);
    const snapshots = this.readSnapshotsForConnection(conn);
    const plan = this.buildValidatedPlan(conn, snapshots, patch);
    this.verifyExpectedVersions(snapshots, plan.fileChanges, expectedVersions, { requireVersions: false });

    const filesPreview = plan.fileChanges.map(fc => {
      const snap = snapshots.get(fc.sourceKey);
      const nextBuffer = Buffer.from(fc.nextText, 'utf8');
      return {
        sourceKey: fc.sourceKey,
        canonicalPath: snap.canonicalPath,
        oldExisted: snap.exists,
        oldSha256: snap.sha256,
        newSha256: sha256Hex(nextBuffer),
      };
    });

    const currentVersions = {};
    for (const [k, snap] of snapshots.entries()) {
      currentVersions[k] = snap.sha256;
    }

    return {
      connectionId: conn.id,
      scope: plan.scope,
      sharedMembers: conn.sharedMembers,
      requiresRestart: plan.requiresRestart,
      applicationMode: plan.applicationMode,
      applicationNote: plan.applicationNote,
      redactedChanges: plan.redactedChanges,
      files: filesPreview,
      currentVersions,
    };
  }

  applyConfigChange(connectionId, { patch, expectedVersions, actor = 'user', requireIdle = false, faultInjector = null, projectDir = null } = {}) {
    if (!this._cachedBackupCipherKey && this.safeStorage?.isBridge) {
      return (async () => {
        await this.ensureBackupCipherKey();
        return this.applyConfigChange(connectionId, { patch, expectedVersions, actor, requireIdle, faultInjector, projectDir });
      })();
    }
    this.assertRecoveryReady();
    const conn = this.repo.requireRegistered(connectionId);
    if (this.locks.has(conn.id)) {
      throw fail('该 Agent 连接正在执行另一项配置变更，请稍后重试。', 'CONFIG_LOCKED', 409);
    }
    const broken = this.repo.hasBrokenChangeState(conn.id);
    if (broken) {
      throw fail(
        `该连接存在未恢复的配置变更故障 (${broken.id})，请先回滚故障变更后再提交新修改。`,
        'CONFIG_APPLY_INCOMPLETE',
        409
      );
    }

    const activeRuns = this.activeRunCountForConnection(conn.id);
    if (requireIdle && activeRuns > 0) {
      throw fail('该连接当前有关联任务正在运行，请等待任务结束后再修改配置。', 'CONNECTION_BUSY', 409);
    }

    this.locks.add(conn.id);
    try {
      const snapshots = this.readSnapshotsForConnection(conn);
      const plan = this.buildValidatedPlan(conn, snapshots, patch);
      this.verifyExpectedVersions(snapshots, plan.fileChanges, expectedVersions, { requireVersions: true });

      const changeId = `cfgchg-${crypto.randomUUID()}`;
      const changeBackupDir = path.join(this.backupsRoot, changeId);
      fs.mkdirSync(changeBackupDir, { recursive: true, mode: 0o700 });

      const fileRecords = [];
      for (const fc of plan.fileChanges) {
        const snap = snapshots.get(fc.sourceKey);
        const nextBuffer = Buffer.from(fc.nextText, 'utf8');
        const newSha256 = sha256Hex(nextBuffer);
        let backupRef = null;

        if (snap.exists && snap.rawBuffer) {
          backupRef = path.join(changeBackupDir, `${fc.sourceKey.replace(/[^A-Za-z0-9._-]/g, '_')}.bak`);
          const encryptedBak = encryptProtectedBackup(snap.rawBuffer, this.backupCipherKey);
          writeFileAtomically(backupRef, encryptedBak, { mode: 0o600 });
          const verifyPlain = decryptProtectedBackup(fs.readFileSync(backupRef), this.backupCipherKey);
          if (sha256Hex(verifyPlain) !== snap.sha256) {
            throw fail('无法校验受保护配置备份，已中止配置写入。', 'BACKUP_VERIFY_FAILED', 500);
          }
          if (typeof faultInjector === 'function') {
            faultInjector({ step: 'during-backup', sourceKey: fc.sourceKey });
          }
        }

        fileRecords.push({
          sourceKey: fc.sourceKey,
          canonicalPath: snap.canonicalPath,
          oldExisted: snap.exists,
          oldSha256: snap.sha256,
          newSha256,
          backupRef,
          mode: snap.mode || 0o600,
          nextBuffer,
          expectedFinalCheck: fc.expectedFinalCheck,
        });
      }

      const persistedFilesMeta = fileRecords.map(r => ({
        sourceKey: r.sourceKey,
        canonicalPath: r.canonicalPath,
        oldExisted: r.oldExisted,
        oldSha256: r.oldSha256,
        newSha256: r.newSha256,
        backupRef: r.backupRef,
      }));

      // Journal: prepared -> applying
      this.repo.createChange({
        id: changeId,
        connectionId: conn.id,
        state: 'prepared',
        scope: plan.scope,
        redactedPatch: plan.redactedChanges,
        files: persistedFilesMeta,
        actor,
      });
      this.repo.updateChangeState(changeId, 'applying');

      const writtenFiles = [];
      try {
        // Write-phase CAS check & native lock coordination:
        // Verify all target files on disk still match oldSha256 before performing any write.
        for (const rec of fileRecords) {
          let curExists = false;
          let curSha = null;
          try {
            const st = fs.lstatSync(rec.canonicalPath);
            if (st.isSymbolicLink()) {
              throw fail(`配置文件 ${rec.sourceKey} 在写入前被替换为符号链接。`, 'CONFIG_CONFLICT', 409);
            }
            if (st.isFile()) {
              curExists = true;
              curSha = sha256Hex(fs.readFileSync(rec.canonicalPath));
            }
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
          if (curExists !== rec.oldExisted || curSha !== rec.oldSha256) {
            throw fail(
              `配置文件 ${rec.sourceKey} 在写入前已被外部修改（版本哈希不匹配），已中止写入以防覆盖外部修改。`,
              'CONFIG_CONFLICT',
              409
            );
          }
        }

        for (let idx = 0; idx < fileRecords.length; idx++) {
          const rec = fileRecords[idx];
          if (typeof faultInjector === 'function') {
            faultInjector({ step: 'before-file-write', index: idx, sourceKey: rec.sourceKey });
          }
          writeFileAtomically(rec.canonicalPath, rec.nextBuffer, {
            mode: rec.mode,
            expectedOldSha256: rec.oldSha256,
            expectedOldExisted: rec.oldExisted,
            sourceKey: rec.sourceKey,
          });
          writtenFiles.push(rec);
          if (typeof faultInjector === 'function') {
            faultInjector({ step: 'after-file-write', index: idx, sourceKey: rec.sourceKey });
          }
        }
      } catch (writeErr) {
        if (writtenFiles.length === 0 && writeErr.code === 'CONFIG_CONFLICT') {
          this.repo.updateChangeState(changeId, 'apply_failed', {
            applyResult: {
              saveStatus: 'conflict',
              retryable: true,
              autoRestored: true,
              error: writeErr.message,
            },
          });
          throw writeErr;
        }

        // Attempt deterministic rollback of already-written files in this multi-file batch.
        let rollbackClean = true;
        for (const rec of writtenFiles.reverse()) {
          try {
            if (rec.oldExisted && rec.backupRef && fs.existsSync(rec.backupRef)) {
              const bakBytes = decryptProtectedBackup(fs.readFileSync(rec.backupRef), this.backupCipherKey);
              writeFileAtomically(rec.canonicalPath, bakBytes, { mode: rec.mode });
              const checkSha = sha256Hex(fs.readFileSync(rec.canonicalPath));
              if (checkSha !== rec.oldSha256) rollbackClean = false;
            } else if (!rec.oldExisted && fs.existsSync(rec.canonicalPath)) {
              fs.unlinkSync(rec.canonicalPath);
            }
          } catch {
            rollbackClean = false;
          }
        }
        this.repo.updateChangeState(changeId, 'apply_failed', {
          applyResult: {
            saveStatus: 'failed',
            autoRestored: rollbackClean,
            error: writeErr.message,
          },
        });
        throw fail(
          rollbackClean
            ? `配置写入失败，已自动恢复原文件版本: ${writeErr.message}`
            : `多文件配置写入中途失败且自动恢复未完全成功，已隔离该连接以阻止在混合配置上启动任务: ${writeErr.message}`,
          'CONFIG_WRITE_FAILED',
          500,
          { changeId, autoRestored: rollbackClean }
        );
      }

      // Journal: committed -> activating
      this.repo.updateChangeState(changeId, 'committed');
      this.repo.updateChangeState(changeId, 'activating');

      // Step 11 & 12: Re-read from disk, verify SHA-256 and native parser semantics.
      for (const rec of fileRecords) {
        const srcMeta = conn.sources.find(s => s.sourceKey === rec.sourceKey);
        const postSnap = readSafeFileSnapshot(srcMeta);
        if (!postSnap.exists || postSnap.sha256 !== rec.newSha256) {
          this.repo.updateChangeState(changeId, 'apply_failed', {
            applyResult: { saveStatus: 'verify_failed', reason: `写后摘要不匹配 (${rec.sourceKey})` },
          });
          throw fail(`配置文件 ${rec.sourceKey} 写后校验不匹配。`, 'CONFIG_VERIFY_FAILED', 500);
        }
        const parsed = srcMeta.format === 'toml'
          ? parseTomlDocument(postSnap.rawText)
          : parseJsonc(postSnap.rawText, rec.sourceKey);
        if (rec.expectedFinalCheck && !rec.expectedFinalCheck(parsed)) {
          this.repo.updateChangeState(changeId, 'apply_failed', {
            applyResult: { saveStatus: 'verify_failed', reason: `原生语义核对未通过 (${rec.sourceKey})` },
          });
          throw fail(`配置文件 ${rec.sourceKey} 写后生效值与预期不符。`, 'CONFIG_VERIFY_FAILED', 500);
        }
        this.repo.updateSourceHash(conn.id, rec.sourceKey, postSnap.sha256);
      }

      const postInspect = this.inspectConfig(conn.id, { projectDir });
      const shadowed = Boolean(postInspect.effective?.shadowedByProject);
      const applicationStatus = shadowed
        ? 'shadowed_by_override'
        : activeRuns > 0
        ? 'next_run_active_untouched'
        : plan.applicationMode || 'next_run';

      const applyResult = {
        saveStatus: 'saved',
        applicationStatus,
        applicationNote: shadowed
          ? '全局配置已保存，但当前项目存在项目级配置覆盖 (.pi/settings.json)，生效值以项目配置为准。'
          : activeRuns > 0
          ? `全局配置已保存；当前有 ${activeRuns} 个运行中的任务保持原配置不中断，下一次任务将使用新配置。`
          : plan.applicationNote,
        verifiedAt: new Date().toISOString(),
        effective: postInspect.effective,
      };

      const completedChange = this.repo.updateChangeState(changeId, 'applied', { applyResult });
      return {
        change: completedChange,
        saveStatus: applyResult.saveStatus,
        applicationStatus: applyResult.applicationStatus,
        applicationNote: applyResult.applicationNote,
        effective: postInspect.effective,
        versions: postInspect.versions,
        sharedMembers: postInspect.connection.sharedMembers,
      };
    } finally {
      this.locks.delete(conn.id);
    }
  }

  rollbackConfigChange(connectionId, { changeId, actor = 'user', projectDir = null } = {}) {
    if (!this._cachedBackupCipherKey && this.safeStorage?.isBridge) {
      return (async () => {
        await this.ensureBackupCipherKey();
        return this.rollbackConfigChange(connectionId, { changeId, actor, projectDir });
      })();
    }
    this.assertRecoveryReady();
    const conn = this.repo.requireRegistered(connectionId);
    if (!changeId || typeof changeId !== 'string') {
      throw fail('回滚时必须指定 changeId。', 'CHANGE_ID_REQUIRED', 400);
    }
    if (this.locks.has(conn.id)) {
      throw fail('该连接正在进行配置修改，请稍后重试。', 'CONFIG_LOCKED', 409);
    }
    if (this.activeRunCountForConnection(conn.id) > 0) {
      throw fail('该连接有关联任务正在运行，请等待任务结束后再执行配置恢复。', 'CONNECTION_BUSY', 409);
    }

    const change = this.repo.getChange(changeId);
    if (!change || change.connectionId !== conn.id) {
      throw fail('未找到对应的配置变更记录。', 'CHANGE_NOT_FOUND', 404);
    }
    if (!['applied', 'apply_failed', 'applying'].includes(change.state)) {
      throw fail(`变更记录状态为 ${change.state}，无法重复回滚。`, 'CHANGE_NOT_ROLLBACKABLE', 409);
    }

    this.locks.add(conn.id);
    try {
      // 若该变更在实际修改任何文件前已因冲突中止（saveStatus='conflict' 或 retryable=true），
      // 磁盘并未落盘本次修改，回滚直接将其状态结转为 rolled_back 并返回，解除连接隔离
      if (change.applyResult?.saveStatus === 'conflict' || change.applyResult?.retryable) {
        const updatedChange = this.repo.updateChangeState(change.id, 'rolled_back', {
          applyResult: {
            ...(change.applyResult || {}),
            rolledBackAt: new Date().toISOString(),
            rolledBackBy: actor,
          },
        });
        const postInspect = this.inspectConfig(conn.id, { projectDir });
        return {
          change: updatedChange,
          restoredStatus: 'rolled_back',
          effective: postInspect.effective,
          versions: postInspect.versions,
        };
      }

      // Step 1: Verify current disk files have not been modified externally since `change` was applied.
      for (const fileMeta of change.files) {
        const srcMeta = conn.sources.find(s => s.sourceKey === fileMeta.sourceKey) || {
          sourceKey: fileMeta.sourceKey,
          canonicalPath: fileMeta.canonicalPath,
        };
        const currentSnap = readSafeFileSnapshot(srcMeta);
        if (change.state === 'applied' && currentSnap.sha256 !== fileMeta.newSha256) {
          throw fail(
            `配置文件 ${fileMeta.sourceKey} 在该次变更之后已被外部修改（记录版本 ${fileMeta.newSha256}，当前版本 ${currentSnap.sha256 || '不存在'}）。为避免抹掉后续合法修改，已拒绝覆盖。`,
            'CONFIG_EXTERNAL_MODIFIED',
            409,
            {
              sourceKey: fileMeta.sourceKey,
              recordedNewSha256: fileMeta.newSha256,
              currentSha256: currentSnap.sha256,
            }
          );
        }
        if (fileMeta.oldExisted) {
          if (!fileMeta.backupRef || !fs.existsSync(fileMeta.backupRef)) {
            throw fail(`缺少配置源 ${fileMeta.sourceKey} 的受保护备份文件，无法执行恢复。`, 'BACKUP_MISSING', 409);
          }
          const bakBytes = decryptProtectedBackup(fs.readFileSync(fileMeta.backupRef), this.backupCipherKey);
          if (sha256Hex(bakBytes) !== fileMeta.oldSha256) {
            throw fail(`配置源 ${fileMeta.sourceKey} 的受保护备份文件摘要校验失败。`, 'BACKUP_CORRUPTED', 500);
          }
        }
      }

      // Step 2: Restore each file atomically.
      for (const fileMeta of change.files) {
        if (fileMeta.oldExisted) {
          const bakBytes = decryptProtectedBackup(fs.readFileSync(fileMeta.backupRef), this.backupCipherKey);
          writeFileAtomically(fileMeta.canonicalPath, bakBytes, { mode: 0o600 });
          const verifySha = sha256Hex(fs.readFileSync(fileMeta.canonicalPath));
          if (verifySha !== fileMeta.oldSha256) {
            throw fail(`恢复配置文件 ${fileMeta.sourceKey} 后校验摘要不一致。`, 'ROLLBACK_VERIFY_FAILED', 500);
          }
          this.repo.updateSourceHash(conn.id, fileMeta.sourceKey, verifySha);
        } else {
          if (fs.existsSync(fileMeta.canonicalPath)) {
            fs.unlinkSync(fileMeta.canonicalPath);
          }
          this.repo.updateSourceHash(conn.id, fileMeta.sourceKey, null);
        }
      }

      const postInspect = this.inspectConfig(conn.id, { projectDir });
      const updatedChange = this.repo.updateChangeState(change.id, 'rolled_back', {
        applyResult: {
          ...(change.applyResult || {}),
          rolledBackAt: new Date().toISOString(),
          rolledBackBy: actor,
        },
      });

      return {
        change: updatedChange,
        restoredStatus: 'rolled_back',
        effective: postInspect.effective,
        versions: postInspect.versions,
      };
    } finally {
      this.locks.delete(conn.id);
    }
  }
}

module.exports = {
  NativeConfigService,
  createMockSafeStorage,
  restrictFilePermissions,
  canonicalizeConfigDir,
  readSafeFileSnapshot,
  writeFileAtomically,
  sha256Hex,
  withVaultInitLock,
  withVaultInitLockSync,
  writeProtectedVaultFileExclusive,
  isProcessAlive,
};
