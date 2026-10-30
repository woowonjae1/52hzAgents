const { startServer } = require('./index');

let serverInstance = null;
let currentPort = 0;

// Determine IPC channel: Electron utilityProcess has process.parentPort; Node child_process has process.send
const ipcPort = process.parentPort || (typeof process.send === 'function' ? {
  on(event, handler) {
    if (event === 'message') {
      process.on('message', (msg) => handler({ data: msg }));
    }
  },
  postMessage(msg) {
    process.send(msg);
  }
} : null);

function sendIpc(msg) {
  if (ipcPort && typeof ipcPort.postMessage === 'function') {
    ipcPort.postMessage(msg);
  }
}

let daemonReqCounter = 0;
const daemonPending = new Map();

function sendIpcRequest(action, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const reqId = `dreq_${++daemonReqCounter}_${Date.now()}`;
    const timer = setTimeout(() => {
      daemonPending.delete(reqId);
      reject(new Error(`Supervisor request '${action}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    daemonPending.set(reqId, { resolve, reject, timer });
    sendIpc({ type: 'REQ', id: reqId, action, payload });
  });
}

// Global unhandled error boundary to prevent abrupt crash and alert supervisor
process.on('uncaughtException', (err) => {
  console.error('[52hzAgents Daemon Uncaught Exception]', err);
  sendIpc({
    type: 'EVENT',
    event: 'daemon:error',
    payload: {
      fatal: true,
      message: err?.message || String(err),
      stack: err?.stack,
    },
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[52hzAgents Daemon Unhandled Rejection]', reason);
  sendIpc({
    type: 'EVENT',
    event: 'daemon:error',
    payload: {
      fatal: false,
      message: reason?.message || String(reason),
      stack: reason?.stack,
    },
  });
});

if (ipcPort) {
  ipcPort.on('message', async (e) => {
    const message = e.data || e;
    const { type, id, payload } = message || {};

    if (type === 'RES' && id && daemonPending.has(id)) {
      const pending = daemonPending.get(id);
      daemonPending.delete(id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Supervisor request failed'));
      return;
    }

    if (type === 'INIT') {
      try {
        const {
          port = 8000,
          userDataPath,
          staticDir,
          credentialsCache,
          apiToken,
        } = payload || {};

        // SafeStorage sync bridge to main process with confirmed request-response
        const safeStorageBridge = {
          isBridge: true,
          isEncryptionAvailable: () => true,
          onSet: async (key, secret) => {
            return sendIpcRequest('VAULT_SET', { id: key, secret });
          },
          onDelete: async (key) => {
            return sendIpcRequest('VAULT_DELETE', { id: key });
          },
        };

        const { server, port: actualPort } = await startServer({
          port,
          userDataPath,
          staticDir,
          runtimeOptions: {
            safeStorage: safeStorageBridge,
            credentialsCache,
            apiToken,
          },
        });

        serverInstance = server;
        currentPort = actualPort;

        sendIpc({
          type: 'RES',
          id,
          success: true,
          result: {
            port: actualPort,
            pid: process.pid,
            platform: process.platform,
            nodeVersion: process.version,
          },
        });
      } catch (err) {
        console.error('[52hzAgents Daemon Init Error]', err);
        sendIpc({
          type: 'RES',
          id,
          success: false,
          error: err.message,
        });
      }
    } else if (type === 'PING') {
      sendIpc({
        type: 'RES',
        id,
        success: true,
        result: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          port: currentPort,
          pid: process.pid,
        },
      });
    } else if (type === 'GET_STATUS') {
      sendIpc({
        type: 'RES',
        id,
        success: true,
        result: {
          running: Boolean(serverInstance),
          port: currentPort,
          pid: process.pid,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      });
    } else if (type === 'IMPORT_PI_CONNECTIONS') {
      try {
        const result = serverInstance?.importPiConnections ? serverInstance.importPiConnections() : { imported: 0 };
        sendIpc({
          type: 'RES',
          id,
          success: true,
          result,
        });
      } catch (err) {
        sendIpc({
          type: 'RES',
          id,
          success: false,
          error: err.message,
        });
      }
    } else if (type === 'SHUTDOWN') {
      try {
        if (serverInstance && typeof serverInstance.shutdown === 'function') {
          await serverInstance.shutdown();
        } else if (serverInstance && typeof serverInstance.close === 'function') {
          await new Promise((resolve) => serverInstance.close(resolve));
        }
        sendIpc({
          type: 'RES',
          id,
          success: true,
          result: { shutdown: true },
        });
        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        sendIpc({
          type: 'RES',
          id,
          success: false,
          error: err.message,
        });
        process.exit(1);
      }
    }
  });
}

module.exports = { sendIpc };
