const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Secure Credential Vault.
 * Uses Electron's safeStorage (Windows DPAPI) in Electron production,
 * and AES-256-GCM fallback when safeStorage is unavailable (e.g. in headless unit tests).
 */
class CredentialVault {
  constructor(userDataPath, safeStorageEngine = null) {
    this.filePath = path.join(userDataPath, 'credentials.json');
    this.safeStorage = safeStorageEngine;
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
    return Boolean(this.get(id));
  }

  get(id) {
    if (!this.data[id]) return null;
    const value = this.decrypt(this.data[id]);
    if (value && this.data[id].startsWith('gcm:')) { this.data[id] = this.encrypt(value); this.save(); }
    return value;
  }

  set(id, secret) {
    const previous = { ...this.data };
    if (!secret) {
      delete this.data[id];
    } else {
      this.data[id] = this.encrypt(secret);
    }
    try { this.save(); } catch (error) { this.data = previous; throw error; }
  }

  delete(id) {
    if (this.data[id]) {
      const previous=this.data[id];
      delete this.data[id];
      try{this.save();}catch(error){this.data[id]=previous;throw error;}
    }
  }

  list() {
    return Object.keys(this.data);
  }
}

module.exports = { CredentialVault };
