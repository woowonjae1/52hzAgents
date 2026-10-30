const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Supervised Backend Service Runner for Electron Main Process.
 * Runs the backend server in a separate utilityProcess (or in-process fallback),
 * offloading heavy SQLite transactions, Git worktrees, file snapshots, and Pi agent cycles
 * away from the Electron UI thread.
 */
class BackendSupervisor extends EventEmitter {
  constructor({
    userDataPath,
    staticDir,
    port = 8000,
    safeStorage = null,
    mode = 'auto',
    autoRestart = true,
    maxRestarts = 5,
    heartbeatIntervalMs = 10000,
    apiToken = null,
  }) {
    super();
    this.userDataPath = userDataPath;
    this.staticDir = staticDir;
    this.port = port;
    this.safeStorage = safeStorage;
    this.mode = mode;
    this.autoRestart = autoRestart;
    this.maxRestarts = maxRestarts;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.apiToken = apiToken || process.env.OPENAGENTS_API_TOKEN || crypto.randomBytes(32).toString('hex');

    this.child = null;
    this.inProcessServer = null;
    this.currentPort = 0;
    this.currentPid = 0;
    this.state = 'stopped'; // 'stopped' | 'starting' | 'running' | 'crashed' | 'restarting'
    this.restartCount = 0;
    this.lastRestartAt = 0;
    this.heartbeatTimer = null;
    this.pendingRequests = new Map();
    this.reqCounter = 0;
    this.credentialsPath = path.join(userDataPath, 'credentials.json');
  }

  /**
   * Decrypt credentials into in-memory dictionary for daemon startup.
   */
  loadCredentialsCache() {
    const cache = {};
    if (!fs.existsSync(this.credentialsPath)) return cache;

    try {
      const raw = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
      for (const [key, cipher] of Object.entries(raw)) {
        if (typeof cipher === 'string' && cipher.startsWith('safe:')) {
          if (this.safeStorage && typeof this.safeStorage.decryptString === 'function') {
            try {
              const buf = Buffer.from(cipher.slice(5), 'base64');
              const decrypted = this.safeStorage.decryptString(buf);
              if (decrypted) cache[key] = decrypted;
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    return cache;
  }

  /**
   * Persist encrypted credential from daemon to disk via DPAPI.
   */
  saveEncryptedCredential(key, secret) {
    if (!secret) {
      this.deleteEncryptedCredential(key);
      return;
    }

    if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function') {
      throw new Error('System credential encryption is unavailable. Secret saving refused.');
    }
    if (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('System credential encryption is not available on this platform.');
    }

    let data = {};
    if (fs.existsSync(this.credentialsPath)) {
      try {
        data = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
      } catch (_) {}
    }

    const encryptedBuf = this.safeStorage.encryptString(secret);
    data[key] = `safe:${encryptedBuf.toString('base64')}`;

    fs.mkdirSync(path.dirname(this.credentialsPath), { recursive: true });
    fs.writeFileSync(this.credentialsPath + '.tmp', JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(this.credentialsPath + '.tmp', this.credentialsPath);
  }

  /**
   * Remove credential from disk.
   */
  deleteEncryptedCredential(key) {
    if (!fs.existsSync(this.credentialsPath)) return;
    const data = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
    if (data[key]) {
      delete data[key];
      fs.writeFileSync(this.credentialsPath + '.tmp', JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(this.credentialsPath + '.tmp', this.credentialsPath);
    }
  }

  /**
   * Determine effective execution mode.
   */
  resolveMode() {
    if (this.mode === 'inProcess') return 'inProcess';
    if (this.mode === 'utilityProcess') return 'utilityProcess';

    // Auto detection: Check if running inside Electron with utilityProcess
    try {
      const electron = require('electron');
      if (electron?.utilityProcess && typeof electron.utilityProcess.fork === 'function') {
        return 'utilityProcess';
      }
    } catch (_) {}

    return 'inProcess';
  }

  /**
   * Start the backend service.
   */
  async start() {
    if (this.state === 'running') {
      return { port: this.currentPort, pid: this.currentPid };
    }

    this.state = 'starting';
    this.emit('state:changed', this.state);

    const effectiveMode = this.resolveMode();

    if (effectiveMode === 'utilityProcess') {
      return this._startUtilityProcess();
    } else {
      return this._startInProcess();
    }
  }

  async _startUtilityProcess() {
    const electron = require('electron');
    const daemonScript = path.join(__dirname, 'daemon.js');
    const credentialsCache = this.loadCredentialsCache();

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const startupTimeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this.state = 'crashed';
          this.emit('state:changed', this.state);
          reject(new Error('Backend daemon startup timed out after 20 seconds.'));
        }
      }, 20000);

      try {
        this.child = electron.utilityProcess.fork(daemonScript, [], {
          serviceName: '52hzAgents-Daemon',
        });

        this.currentPid = this.child.pid;

        this.child.on('message', (message) => {
          this._handleIpcMessage(message);
        });

        this.child.on('exit', (code) => {
          this._handleChildExit(code);
        });

        // Send INIT request
        this.sendRequest('INIT', {
          port: this.port,
          userDataPath: this.userDataPath,
          staticDir: this.staticDir,
          apiToken: this.apiToken,
          credentialsCache,
        })
          .then((res) => {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(startupTimeout);
              this.currentPort = res.port;
              this.currentPid = res.pid || this.child.pid;
              this.state = 'running';
              this.emit('state:changed', this.state);
              this._startHeartbeat();
              resolve({ port: this.currentPort, pid: this.currentPid });
            }
          })
          .catch((err) => {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(startupTimeout);
              this.state = 'crashed';
              this.emit('state:changed', this.state);
              reject(err);
            }
          });
      } catch (err) {
        clearTimeout(startupTimeout);
        this.state = 'crashed';
        this.emit('state:changed', this.state);
        reject(err);
      }
    });
  }

  async _startInProcess() {
    const { startServer } = require('./index');
    const credentialsCache = this.loadCredentialsCache();

    const { server, port: actualPort } = await startServer({
      port: this.port,
      userDataPath: this.userDataPath,
      staticDir: this.staticDir,
      runtimeOptions: {
        safeStorage: this.safeStorage,
        credentialsCache,
        apiToken: this.apiToken,
      },
    });

    this.inProcessServer = server;
    this.currentPort = actualPort;
    this.currentPid = process.pid;
    this.state = 'running';
    this.emit('state:changed', this.state);

    return { port: this.currentPort, pid: this.currentPid };
  }

  /**
   * Handle incoming IPC messages from child process.
   */
  _handleIpcMessage(message) {
    if (!message || typeof message !== 'object') return;

    // 1. Response to request
    if (message.type === 'RES' && message.id) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.success) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error || 'Daemon request failed'));
        }
      }
      return;
    }

    // 2. Events from child
    if (message.type === 'EVENT') {
      if (message.event === 'daemon:error' && message.payload) {
        console.error('[BackendSupervisor Child Error]', message.payload);
        this.emit('error', message.payload);
      }
      this.emit(message.event, message.payload);
      return;
    }

    // 3. Request calls from child daemon (e.g. credential operations requiring main process DPAPI)
    if (message.type === 'REQ' && message.id) {
      try {
        if (message.action === 'VAULT_SET') {
          this.saveEncryptedCredential(message.payload.id, message.payload.secret);
          this.child.postMessage({ type: 'RES', id: message.id, success: true });
        } else if (message.action === 'VAULT_DELETE') {
          this.deleteEncryptedCredential(message.payload.id);
          this.child.postMessage({ type: 'RES', id: message.id, success: true });
        } else {
          this.child.postMessage({ type: 'RES', id: message.id, success: false, error: `Unknown daemon action '${message.action}'` });
        }
      } catch (err) {
        this.child.postMessage({ type: 'RES', id: message.id, success: false, error: err.message });
      }
      return;
    }
  }

  /**
   * Send a structured request to child process and wait for response.
   */
  sendRequest(type, payload = {}, timeoutMs = 15000) {
    if (!this.child) {
      return Promise.reject(new Error('Child process is not running'));
    }

    return new Promise((resolve, reject) => {
      const id = `req_${++this.reqCounter}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Daemon request '${type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.child.postMessage({ type, id, payload });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Heartbeat ping to verify daemon responsiveness.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this.state !== 'running' || !this.child) return;
      try {
        const pong = await this.sendRequest('PING', {}, 5000);
        this.emit('heartbeat', pong);
      } catch (err) {
        console.warn('[BackendSupervisor] Heartbeat missed:', err.message);
        this.emit('heartbeat:missed', err);
      }
    }, this.heartbeatIntervalMs);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Handle child process exit.
   */
  _handleChildExit(code) {
    this._stopHeartbeat();
    this.child = null;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Daemon exited with code ${code}`));
    }
    this.pendingRequests.clear();

    if (this.state === 'stopped') {
      // Intentional shutdown
      return;
    }

    console.warn(`[BackendSupervisor] Daemon child process exited unexpectedly with code ${code}`);
    this.state = 'crashed';
    this.emit('crashed', { code });
    this.emit('state:changed', this.state);

    // Auto-restart if allowed
    const now = Date.now();
    if (this.autoRestart && (now - this.lastRestartAt > 60000 || this.restartCount < this.maxRestarts)) {
      if (now - this.lastRestartAt > 60000) {
        this.restartCount = 0; // Reset counter after 1 min of stable run
      }
      this.restartCount++;
      this.lastRestartAt = now;
      console.log(`[BackendSupervisor] Auto-restarting backend daemon (attempt ${this.restartCount}/${this.maxRestarts})...`);
      this.state = 'restarting';
      this.emit('state:changed', this.state);
      setTimeout(() => {
        this.start().catch((err) => {
          console.error('[BackendSupervisor] Auto-restart failed:', err);
        });
      }, 1000);
    }
  }

  /**
   * Graceful shutdown of the backend service.
   */
  async stop() {
    this._stopHeartbeat();
    this.state = 'stopped';
    this.emit('state:changed', this.state);

    if (this.inProcessServer) {
      if (typeof this.inProcessServer.shutdown === 'function') {
        await this.inProcessServer.shutdown();
      } else {
        await new Promise((resolve) => this.inProcessServer.close(resolve));
      }
      this.inProcessServer = null;
      this.currentPort = 0;
      this.currentPid = 0;
      return;
    }

    if (this.child) {
      try {
        await this.sendRequest('SHUTDOWN', {}, 3000);
      } catch (_) {
        try {
          this.child.kill();
        } catch (__) {}
      }
      this.child = null;
      this.currentPort = 0;
      this.currentPid = 0;
    }
  }

  /**
   * Import connections from Pi configuration.
   */
  async importPiConnections() {
    if (this.inProcessServer && typeof this.inProcessServer.importPiConnections === 'function') {
      return this.inProcessServer.importPiConnections();
    }
    if (this.child && this.state === 'running') {
      return this.sendRequest('IMPORT_PI_CONNECTIONS', {}, 5000);
    }
    throw new Error('Backend service is not running');
  }

  /**
   * Restart the backend service.
   */
  async restart() {
    await this.stop();
    return this.start();
  }

  /**
   * Get current operational status.
   */
  async getStatus() {
    const baseStatus = {
      state: this.state,
      port: this.currentPort,
      pid: this.currentPid,
      restartCount: this.restartCount,
      mode: this.resolveMode(),
    };

    if (this.child && this.state === 'running') {
      try {
        const stats = await this.sendRequest('GET_STATUS', {}, 2000);
        return { ...baseStatus, ...stats };
      } catch (_) {}
    }

    return baseStatus;
  }
}

module.exports = { BackendSupervisor };
