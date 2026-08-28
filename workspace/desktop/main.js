const { app, BrowserWindow, Menu, Tray, shell, globalShortcut, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn, execSync, fork } = require('child_process');

// 1. Isolate userData folder & disable GPU shader cache lock (0x5)
try {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
  const customUserData = path.join(app.getPath('appData'), '52hzAgents-Desktop');
  app.setPath('userData', customUserData);
} catch (e) {}

let mainWindow = null;
let quickBarWindow = null;
let tray = null;
let isQuitting = false;

// Production / Development Configuration
const isPackaged = app.isPackaged;
const DEFAULT_PORT = 8000;
let serverPort = DEFAULT_PORT;
let TARGET_URL = process.env.FRONTEND_URL || (isPackaged ? `http://127.0.0.1:${DEFAULT_PORT}/` : 'http://127.0.0.1:3005/');

let backendProcess = null;
let connectorProcess = null;
let sseReq = null;
let devStackSpawned = false;

// Dynamic port discovery helper
function findFreePort(startPort = 8000) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
  });
}

function checkServerReady(url, callback) {
  const testUrl = url.replace('localhost', '127.0.0.1');
  const req = http.get(testUrl, (res) => {
    if (res.statusCode && res.statusCode < 500) {
      callback(true);
    } else {
      callback(false);
    }
  });
  req.on('error', () => callback(false));
  req.setTimeout(2500, () => {
    req.destroy();
    callback(false);
  });
}

// Kill child process tree cleanly on Windows and Unix
function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) {}
}

// Clean up any lingering 52hz-server orphan processes from previous crashes
function cleanupOrphans() {
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /IM 52hz-server.exe /F', { stdio: 'ignore' });
    } catch (e) {}
  }
  // Clear any stale WWJ daemon PID file and kill stale daemon process
  try {
    const os = require('os');
    const wwjConfigDir = path.join(os.homedir(), '.wwj');
    const pidFile = path.join(wwjConfigDir, 'daemon.pid');
    if (fs.existsSync(pidFile)) {
      const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (pid) {
        killProcessTree(pid);
      }
      try { fs.unlinkSync(pidFile); } catch {}
    }
  } catch (e) {}
}

async function startProductionStack() {
  const userData = app.getPath('userData');
  const dbPath = path.join(userData, 'workspace.db');
  const filesPath = path.join(userData, 'files');

  try {
    fs.mkdirSync(filesPath, { recursive: true });
  } catch (e) {}

  cleanupOrphans();

  // Find an available port dynamically
  serverPort = await findFreePort(DEFAULT_PORT);
  TARGET_URL = `http://127.0.0.1:${serverPort}/`;
  console.log(`[52hzAgents Desktop] Selected port: ${serverPort}`);

  // Locate 52hz-server binary
  const binaryName = process.platform === 'win32' ? '52hz-server.exe' : '52hz-server';
  const possibleServerPaths = [
    path.join(process.resourcesPath, 'bin', binaryName),
    path.join(process.resourcesPath, binaryName),
    path.join(__dirname, 'resources', 'bin', binaryName),
    path.join(__dirname, '..', 'backend', binaryName),
  ];

  const possiblePublicPaths = [
    path.join(process.resourcesPath, 'public'),
    path.join(__dirname, 'resources', 'public'),
    path.join(__dirname, '..', 'frontend', 'out'),
  ];

  let serverBin = possibleServerPaths.find((p) => fs.existsSync(p));
  let publicPath = possiblePublicPaths.find((p) => fs.existsSync(p)) || path.join(process.resourcesPath, 'public');

  if (serverBin) {
    console.log(`[52hzAgents Desktop] Starting bundled server from ${serverBin}`);
    const spawnServer = () => {
      backendProcess = spawn(serverBin, [], {
        env: {
          ...process.env,
          CGO_ENABLED: '0',
          PORT: `${serverPort}`,
          DATABASE_URL: `sqlite://${dbPath.replace(/\\/g, '/')}`,
          FILE_STORAGE_PATH: filesPath,
          AUTH_MODE: 'none',
          CORS_ORIGINS: '*',
          FRONTEND_STATIC_PATH: publicPath,
        },
        stdio: 'ignore',
        detached: false,
      });
      backendProcess.on('exit', (code, signal) => {
        if (!isQuitting) {
          console.warn(`[52hzAgents Desktop] 52hz-server exited unexpectedly (code: ${code}, signal: ${signal}), restarting in 1s...`);
          setTimeout(spawnServer, 1000);
        }
      });
    };
    spawnServer();
  } else {
    console.warn('[52hzAgents Desktop] Bundled 52hz-server binary not found, attempting fallback');
  }

  // Launch WWJ Agent Connector in foreground mode using Electron's internal Node runtime
  const possibleWwjPaths = [
    path.join(process.resourcesPath, 'wwj', 'bin', 'agent-connector.js'),
    path.join(__dirname, 'resources', 'wwj', 'bin', 'agent-connector.js'),
    path.join(__dirname, '..', '..', 'packages', 'wwj', 'bin', 'agent-connector.js'),
  ];

  const wwjEntry = possibleWwjPaths.find((p) => fs.existsSync(p));
  if (wwjEntry) {
    console.log(`[52hzAgents Desktop] Starting WWJ connector from ${wwjEntry} (endpoint: http://127.0.0.1:${serverPort})`);
    const spawnConnector = () => {
      connectorProcess = fork(wwjEntry, ['up', '--foreground', '--endpoint', `http://127.0.0.1:${serverPort}`], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          WWJ_WORKSPACE_ENDPOINT: `http://127.0.0.1:${serverPort}`,
        },
        stdio: 'ignore',
      });
      connectorProcess.on('exit', (code, signal) => {
        if (!isQuitting) {
          console.warn(`[52hzAgents Desktop] WWJ connector exited unexpectedly (code: ${code}, signal: ${signal}), restarting in 1.5s...`);
          setTimeout(spawnConnector, 1500);
        }
      });
    };
    spawnConnector();
  }

  // Subscribe to live SSE events for approval notifications
  setTimeout(() => subscribeApprovalEvents(`http://127.0.0.1:${serverPort}`), 3000);
}

function subscribeApprovalEvents(baseUrl) {
  try {
    const sseUrl = `${baseUrl}/v1/events/stream?network=default`;
    sseReq = http.get(sseUrl, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[52hzAgents Desktop] SSE stream returned HTTP ${res.statusCode}, retrying in 5s...`);
        setTimeout(() => subscribeApprovalEvents(baseUrl), 5000);
        return;
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep partial line
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const event = JSON.parse(line.slice(5).trim());
              if (event && event.type === 'workspace.agent.approval.requested') {
                const payload = event.payload || {};
                const approvalId = payload.approval_id || payload.id || event.id;
                const agentName = payload.agent_name || event.source || 'Agent';
                const action = payload.action || payload.command || 'Sensitive Operation';
                showApprovalNotification(agentName, action, approvalId);
              }
            } catch (err) {}
          }
        }
      });
      res.on('end', () => {
        setTimeout(() => subscribeApprovalEvents(baseUrl), 3000);
      });
      res.on('error', () => {
        setTimeout(() => subscribeApprovalEvents(baseUrl), 5000);
      });
    });
    sseReq.on('error', () => {
      setTimeout(() => subscribeApprovalEvents(baseUrl), 5000);
    });
  } catch (e) {}
}

function cleanupDevStack() {
  if (!devStackSpawned) return;
  try {
    const scriptPath = path.resolve(__dirname, '../dev-sqlite.ps1');
    spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Stop'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) {}
}

function ensureDevStackRunning() {
  if (isPackaged) {
    startProductionStack();
    return;
  }

  checkServerReady(TARGET_URL, (ready) => {
    if (ready) {
      console.log('[52hzAgents Desktop] Connected to local server at 127.0.0.1:3005.');
      subscribeApprovalEvents('http://127.0.0.1:8000');
      return;
    }
    if (devStackSpawned) return;
    devStackSpawned = true;
    console.log('[52hzAgents Desktop] Starting dev-sqlite.ps1 stack...');
    const scriptPath = path.resolve(__dirname, '../dev-sqlite.ps1');
    const devServerProcess = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: path.resolve(__dirname, '..'),
      detached: true,
      stdio: 'ignore',
    });
    devServerProcess.unref();
    setTimeout(() => subscribeApprovalEvents('http://127.0.0.1:8000'), 5000);
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    tray = new Tray(iconPath);
    tray.setToolTip('52hzAgents Workspace');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示 52hzAgents Workspace',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: '呼出 Quick Bar (Alt+Space)',
        click: () => {
          toggleQuickBar();
        },
      },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
        },
      },
      {
        label: '刷新界面 (F5)',
        click: () => {
          if (mainWindow) mainWindow.reload();
        },
      },
      {
        label: '开发者工具 (F12)',
        click: () => {
          if (mainWindow) mainWindow.webContents.toggleDevTools();
        },
      },
      { type: 'separator' },
      {
        label: '退出应用',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (e) {
    console.log('[52hzAgents Desktop] Tray setup skipped:', e.message);
  }
}

function createMainWindow() {
  const appIconPath = path.join(__dirname, 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '52hzAgents Workspace',
    icon: appIconPath,
    backgroundColor: '#0e0e10',
    darkTheme: true,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(0, 0, 0, 0)',
      symbolColor: '#8a8a8a',
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // Enables <webview> for the Local Preview panel. A <webview> is its own
      // WebContents, which is the only way to show a dev server running on this
      // machine: an <iframe> in the renderer is blocked as mixed content when
      // the workspace is served over https, is refused outright by any target
      // sending X-Frame-Options, and can never expose its console to us.
      //
      // It also widens the attack surface, so `will-attach-webview` below locks
      // down what may be attached. Only this window gets the flag — the
      // quick-bar window has no use for it.
      webviewTag: true,
    },
  });

  // Guard every <webview> attach. Two independent things are enforced here:
  //
  //  1. The child gets no preload and no node integration, whatever the
  //     renderer asked for. Without this a compromised renderer could attach a
  //     webview that runs with the app's own preload bridge.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;

    let allowed = false;
    try {
      const u = new URL(params.src);
      allowed = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      allowed = false;
    }

    if (!allowed) {
      console.warn(`[preview] blocked non-http(s) webview src: ${params.src}`);
      event.preventDefault();
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [${level}] ${message} (${sourceId}:${line})`);
  });

  let isAppLoaded = false;
  let retryCount = 0;
  const maxRetries = 60;

  function loadAppUrl() {
    if (isAppLoaded) return;
    checkServerReady(TARGET_URL, (ready) => {
      if (isAppLoaded) return;
      if (ready) {
        isAppLoaded = true;
        mainWindow.loadURL(TARGET_URL);
        mainWindow.show();
      } else if (retryCount < maxRetries) {
        retryCount++;
        setTimeout(loadAppUrl, 1000);
      } else {
        isAppLoaded = true;
        mainWindow.loadURL(`data:text/html;charset=utf-8,
          <html>
            <body style="background:#0e0e10;color:#f4f4f5;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
              <h2>Unable to connect to 52hzAgents Server</h2>
              <p style="color:#a1a1aa">Target URL: ${TARGET_URL}</p>
              <button onclick="location.reload()" style="background:#27272a;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;margin-top:16px;">Retry Connection</button>
            </body>
          </html>
        `);
        mainWindow.show();
      }
    });
  }

  loadAppUrl();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file:') || url.startsWith('vscode:') || url.startsWith('cursor:')) {
      try {
        if (url.startsWith('file:')) {
          let filePath = decodeURIComponent(url.replace(/^file:\/\/\/?/i, '')).split('#')[0];
          if (process.platform === 'win32') {
            if (filePath.startsWith('/') && /^[a-zA-Z]:/i.test(filePath.slice(1))) {
              filePath = filePath.slice(1);
            }
            filePath = filePath.replace(/\//g, '\\');
          }
          const fs = require('fs');
          if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            if (process.platform === 'win32') {
              const { exec } = require('child_process');
              exec(`explorer.exe "${filePath}"`);
            } else {
              shell.openPath(filePath);
            }
          } else {
            shell.openPath(filePath);
          }
        } else {
          shell.openExternal(url);
        }
      } catch (e) {
        console.error('[52hzAgents] Failed to open local file link:', e);
      }
      return { action: 'deny' };
    }
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createQuickBarWindow() {
  quickBarWindow = new BrowserWindow({
    width: 740,
    height: 120,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const quickBarUrl = TARGET_URL.endsWith('/')
    ? `${TARGET_URL}quickbar`
    : `${TARGET_URL}/quickbar`;

  quickBarWindow.loadURL(quickBarUrl).catch(() => {});

  quickBarWindow.on('blur', () => {
    if (quickBarWindow && quickBarWindow.isVisible()) {
      quickBarWindow.hide();
    }
  });
}

function toggleQuickBar() {
  if (!quickBarWindow) {
    createQuickBarWindow();
  }

  if (quickBarWindow.isVisible()) {
    quickBarWindow.hide();
  } else {
    quickBarWindow.show();
    quickBarWindow.focus();
  }
}

// OS Notification for Approvals
function showApprovalNotification(agentName, action, approvalId) {
  if (!Notification.isSupported()) return;

  const notif = new Notification({
    title: `52hzAgents: Approval Required`,
    body: `Agent @${agentName} requested permission to execute: ${action}`,
    actions: [
      { type: 'button', text: 'Approve' },
      { type: 'button', text: 'Reject' },
    ],
  });

  notif.on('action', (event, index) => {
    const decision = index === 0 ? 'approved' : 'rejected';
    const req = http.request(
      `http://127.0.0.1:${serverPort}/v1/approvals/${approvalId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' } }
    );
    req.write(JSON.stringify({ status: decision }));
    req.end();
  });

  notif.show();
}

// IPC Handlers
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('get-api-url-sync', (event) => {
  event.returnValue = isPackaged ? `http://127.0.0.1:${serverPort}` : 'http://127.0.0.1:8000';
});
ipcMain.handle('get-api-url', () => (isPackaged ? `http://127.0.0.1:${serverPort}` : 'http://127.0.0.1:8000'));
ipcMain.on('window-close', () => mainWindow?.hide());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.on('quickbar-hide', () => quickBarWindow?.hide());
ipcMain.on('main-window-open', (event, route) => {
  if (mainWindow) {
    if (route) {
      const fullUrl = route.startsWith('http') ? route : `${TARGET_URL.replace(/\/$/, '')}${route}`;
      mainWindow.loadURL(fullUrl);
    }
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.handle('app-get-autostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('app-set-autostart', (event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});

// Instant Native Folder Picker (0ms delay using Win32 IFileDialog via Electron C++ API)
ipcMain.handle('dialog-open-folder', async (event, defaultPath) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择本地项目或工作区目录',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  } catch (err) {
    console.error('[52hzAgents] Native dialog-open-folder error:', err);
    return null;
  }
});

// Shell local file & folder openers
ipcMain.handle('shell-open-path', async (event, pathStr) => {
  if (!pathStr) return false;
  try {
    if (pathStr.startsWith('http://') || pathStr.startsWith('https://')) {
      shell.openExternal(pathStr);
      return true;
    }
    if (pathStr.startsWith('vscode:') || pathStr.startsWith('cursor:')) {
      shell.openExternal(pathStr);
      return true;
    }
    let cleanPath = decodeURIComponent(pathStr.replace(/^file:\/\/\/?/i, '')).split('#')[0];
    if (process.platform === 'win32') {
      if (cleanPath.startsWith('/') && /^[a-zA-Z]:/i.test(cleanPath.slice(1))) {
        cleanPath = cleanPath.slice(1);
      }
      cleanPath = cleanPath.replace(/\//g, '\\');
    }
    const fs = require('fs');
    if (fs.existsSync(cleanPath)) {
      const stat = fs.statSync(cleanPath);
      if (stat.isDirectory()) {
        if (process.platform === 'win32') {
          const { exec } = require('child_process');
          exec(`explorer.exe "${cleanPath}"`);
          return true;
        } else if (process.platform === 'darwin') {
          const { exec } = require('child_process');
          exec(`open "${cleanPath}"`);
          return true;
        }
      }
    }
    // Nothing exists at that path. Reporting `true` here is how a click on an
    // unresolvable path came to raise a "Opened locally" toast: `openPath` fails,
    // `showItemInFolder` silently does nothing for a path that is not there, and
    // the handler said it worked anyway.
    if (!fs.existsSync(cleanPath)) {
      console.warn('[52hzAgents] shell-open-path: no such path:', cleanPath);
      return false;
    }

    const err = await shell.openPath(cleanPath);
    if (!err) return true;

    // `openPath` refuses files it has no handler for. Revealing the file in the
    // OS file manager is a real outcome, so it still counts as success — but
    // only if that call itself does not throw.
    try {
      shell.showItemInFolder(cleanPath);
      return true;
    } catch {
      console.error('[52hzAgents] shell-open-path failed:', cleanPath, err);
      return false;
    }
  } catch (e) {
    console.error('[52hzAgents] shell-open-path error:', e);
    return false;
  }
});

ipcMain.handle('shell-show-item', async (event, pathStr) => {
  if (!pathStr) return false;
  try {
    let cleanPath = decodeURIComponent(pathStr.replace(/^file:\/\/\/?/, '')).split('#')[0];
    if (process.platform === 'win32') {
      if (cleanPath.startsWith('/') && /^[a-zA-Z]:/.test(cleanPath.slice(1))) {
        cleanPath = cleanPath.slice(1);
      }
    }
    shell.showItemInFolder(cleanPath);
    return true;
  } catch (e) {
    console.error('[52hzAgents] shell-show-item error:', e);
    return false;
  }
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.52hzagents.app');
  }

  if (isPackaged) {
    await startProductionStack();
  } else {
    ensureDevStackRunning();
  }

  createMainWindow();
  createQuickBarWindow();
  createTray();

  // Register Global Hotkey (Alt + Space) to summon Quick Bar
  try {
    globalShortcut.register('Alt+Space', () => {
      toggleQuickBar();
    });
  } catch (e) {
    console.warn('[52hzAgents Desktop] Failed to register Alt+Space global shortcut:', e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createQuickBarWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (sseReq) sseReq.destroy();
  if (backendProcess) killProcessTree(backendProcess.pid);
  if (connectorProcess) killProcessTree(connectorProcess.pid);
  cleanupDevStack();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
