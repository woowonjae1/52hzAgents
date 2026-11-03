const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Secure Credential Vault.
 * Uses Electron's safeStorage (Windows DPAPI) in Electron production,
 * and AES-256-GCM fallback when safeStorage is unavailable (e.g. in headless unit tests).
 */
class CredentialVault {
  constructor(userDataPath, safeStorageEngine = null, initialCache = null) {
    this.filePath = path.join(userDataPath, 'credentials.json');
    this.safeStorage = safeStorageEngine;
    this.cache = initialCache && typeof initialCache === 'object' ? { ...initialCache } : {};
    if (!this.safeStorage) {
      try {
        const electron = require('electron');
        if (electron?.safeStorage?.isEncryptionAvailable?.()) {
          this.safeStorage = electron.safeStorage;
        }
      } catch (_) {
        // Not in Electron runtime (e.g. standalone Node.js test)
      }
    }
    // Read-only legacy migration key. Never use it to encrypt new credentials.
    this.fallbackKey = crypto.createHash('sha256').update(userDataPath).digest();
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  invalidate() {
    this.cache = {};
    this.data = {};
    this.unavailable = true;
  }

  async reload() {
    // Never expose a previous secret while restoring or after a failed IPC request.
    this.invalidate();
    try {
      const data = fs.existsSync(this.filePath) ? JSON.parse(fs.readFileSync(this.filePath, 'utf8')) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid credential file.');
      let cache = {};
      if (this.safeStorage?.isBridge) {
        if (typeof this.safeStorage.onReload !== 'function') throw new Error('Credential reload bridge is unavailable.');
        const freshCache = await this.safeStorage.onReload();
        if (!freshCache || typeof freshCache !== 'object' || Array.isArray(freshCache)) throw new Error('Invalid credential reload response.');
        cache = { ...freshCache };
      } else {
        for (const [id, cipher] of Object.entries(data)) {
          if (typeof cipher === 'string') {
            const value = this.decrypt(cipher);
            if (value) cache[id] = value;
          }
        }
      }
      for (const [id, cipher] of Object.entries(data)) {
        if (cipher && (typeof cache[id] !== 'string' || !cache[id])) throw new Error('A restored credential could not be decrypted.');
      }
      this.data = data;
      this.cache = cache;
      this.unavailable = false;
      return this.data;
    } catch (error) {
      this.invalidate();
      throw new Error(`Failed to reload decrypted credentials${this.safeStorage?.isBridge ? ' via bridge' : ''}: ${error.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath+'.tmp', JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(this.filePath+'.tmp',this.filePath);
    } catch (err) { throw new Error('Could not persist encrypted credentials.'); }
  }

  encrypt(plainText) {
    if (!plainText) return '';
    if (this.safeStorage?.isEncryptionAvailable?.()) {
      const encryptedBuf = this.safeStorage.encryptString(plainText);
      return `safe:${encryptedBuf.toString('base64')}`;
    }
    throw Object.assign(new Error('System credential encryption is unavailable. Start the desktop app to save a key.'), { status: 503 });
  }

  decrypt(cipherText) {
    if (!cipherText) return null;
    try {
      if (cipherText.startsWith('safe:')) {
        const buf = Buffer.from(cipherText.slice(5), 'base64');
        if (this.safeStorage && typeof this.safeStorage.decryptString === 'function') {
          return this.safeStorage.decryptString(buf);
        }
        return null;
      }
      if (cipherText.startsWith('gcm:')) {
        if (!this.safeStorage?.isEncryptionAvailable?.()) return null;
        const [, ivB64, tagB64, encB64] = cipherText.split(':');
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        const enc = Buffer.from(encB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.fallbackKey, iv);
        decipher.setAuthTag(tag);
        return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  has(id) {
    if (this.unavailable) return false;
    if (this.cache[id]) return true;
    return Boolean(this.get(id));
  }

  get(id) {
    if (this.unavailable) return null;
    if (this.cache[id]) return this.cache[id];
    if (!this.data[id]) return null;
    const value = this.decrypt(this.data[id]);
    if (value) {
      this.cache[id] = value;
      if (this.data[id].startsWith('gcm:')) {
        this.data[id] = this.encrypt(value);
        this.save();
      }
    }
    return value;
  }

  set(id, secret) {
    if (this.unavailable) throw Object.assign(new Error('Credential recovery is incomplete. Retry system recovery first.'), { status: 503 });
    const previousData = { ...this.data };
    const previousCache = this.cache[id];
    if (!secret) {
      if (this.safeStorage?.isBridge) {
        delete this.cache[id];
        delete this.data[id];
        if (typeof this.safeStorage?.onDelete === 'function') {
          return Promise.resolve(this.safeStorage.onDelete(id)).catch(err => {
            if (previousCache !== undefined) this.cache[id] = previousCache;
            this.data = previousData;
            throw err;
          });
        }
        return Promise.resolve();
      }
      delete this.cache[id];
      delete this.data[id];
      this.save();
      return;
    }

    if (this.safeStorage?.isBridge) {
      if (typeof this.safeStorage?.onSet === 'function') {
        return Promise.resolve(this.safeStorage.onSet(id, secret)).then(
          res => {
            this.cache[id] = secret;
            return res;
          },
          err => {
            if (previousCache !== undefined) this.cache[id] = previousCache;
            else delete this.cache[id];
            throw err;
          }
        );
      }
      this.cache[id] = secret;
      return Promise.resolve();
    }

    const encrypted = this.encrypt(secret);
    this.data[id] = encrypted;
    this.cache[id] = secret;
    try {
      this.save();
    } catch (error) {
      this.data = previousData;
      if (previousCache !== undefined) this.cache[id] = previousCache;
      else delete this.cache[id];
      throw error;
    }
  }

  delete(id) {
    if (this.unavailable) throw Object.assign(new Error('Credential recovery is incomplete. Retry system recovery first.'), { status: 503 });
    const previousCache = this.cache[id];
    const previousData = { ...this.data };
    if (this.safeStorage?.isBridge) {
      delete this.cache[id];
      delete this.data[id];
      if (typeof this.safeStorage?.onDelete === 'function') {
        return Promise.resolve(this.safeStorage.onDelete(id)).catch(err => {
          if (previousCache !== undefined) this.cache[id] = previousCache;
          this.data = previousData;
          throw err;
        });
      }
      return Promise.resolve();
    }
    delete this.cache[id];
    if (this.data[id]) {
      const previous = this.data[id];
      delete this.data[id];
      try {
        this.save();
      } catch (error) {
        this.data[id] = previous;
        if (previousCache !== undefined) this.cache[id] = previousCache;
        throw error;
      }
    }
  }

  list() {
    return Array.from(new Set([...Object.keys(this.data), ...Object.keys(this.cache)]));
  }
}

module.exports = { CredentialVault };
