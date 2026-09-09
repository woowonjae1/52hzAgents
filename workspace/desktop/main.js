const { app, BrowserWindow, Menu, Tray, shell, globalShortcut, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn, execSync, fork } = require('child_process');

// 1. Isolate userData folder & configure GPU acceleration
try {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  // `disable-gpu-shader-disk-cache` and `disable-gpu-program-cache` used to sit
  // here, directly under the two switches above, and undid part of what they
  // buy: with both caches off every launch recompiles the shader programs for
  // every draw path the UI hits, and nothing is retained between runs. Turning
  // GPU rasterisation on and then refusing to keep its compiled programs is a
  // contradiction. If they were added to work around a shader-cache write
  // failure in the packaged app, the fix is the userData path below, not
  // disabling the cache.
  const customUserData = path.join(app.getPath('appData'), '52hzAgents-Desktop');
  app.setPath('userData', customUserData);
} catch (e) {}

function getAssetPath(filename) {
  const unpackedPath = path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), filename);
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  return path.join(__dirname, filename);
}


/**
 * Height of the app's own titlebar band, and the value handed to
 * `titleBarOverlay.height` so the native caption buttons are drawn exactly
 * inside it. MUST equal TITLEBAR_HEIGHT in frontend/lib/desktop.ts and
 * `--titlebar-height` in frontend/styles/globals.css: the overlay used to be
 * 38px against a 28px reservation in the renderer, which left the bottom of
 * the minimise/close buttons sitting on top of the app's content.
 */
const TITLEBAR_HEIGHT = 36;

/**
 * The window's ground colour, painted before the renderer's first frame.
 * Matches `--surface0` of the dark theme (globals.css). It was #0e0e10, which
 * is not any colour in the palette, so every launch flashed a slightly wrong
 * grey before the app painted over it.
 */
const WINDOW_BACKGROUND = '#09090b';

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

/**
 * Window geometry, remembered across launches.
 *
 * A desktop window that reopens at 1360x860 in the middle of the screen every
 * time — forgetting that it was maximised, or parked on a second monitor — is
 * one of the clearest tells that a window is really a web page. Stored as JSON
 * in userData rather than pulling in electron-store, which would be the app's
 * only runtime dependency.
 */
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WINDOW_STATE = { width: 1360, height: 860, maximized: false };

function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    const state = {
      width: Number.isFinite(raw.width) ? Math.max(960, raw.width) : DEFAULT_WINDOW_STATE.width,
      height: Number.isFinite(raw.height) ? Math.max(640, raw.height) : DEFAULT_WINDOW_STATE.height,
      maximized: !!raw.maximized,
    };
    // x/y are only honoured together, and only if they land on a display that
    // still exists — otherwise an unplugged second monitor opens the window
    // off-screen where it cannot be dragged back.
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      const { screen } = require('electron');
      const visible = screen.getAllDisplays().some(({ workArea: a }) =>
        raw.x >= a.x - 8 && raw.y >= a.y - 8 &&
        raw.x < a.x + a.width - 48 && raw.y < a.y + a.height - 48);
      if (visible) { state.x = raw.x; state.y = raw.y; }
    }
    return state;
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function persistWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    // getNormalBounds(), not getBounds(): while maximised the latter reports the
    // screen, so saving it would make "restore" a no-op forever after.
    const { x, y, width, height } = win.getNormalBounds();
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ x, y, width, height, maximized: win.isMaximized() }),
    );
  } catch {}
}

/** Trailing-edge debounce: resize/move fire continuously while dragging. */
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

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
          PARENT_PID: `${process.pid}`,
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

  // Subscribe to live SSE events for workspace notifications and approvals
  setTimeout(() => subscribeWorkspaceEvents(`http://127.0.0.1:${serverPort}`), 3000);
}

function subscribeWorkspaceEvents(baseUrl) {
  try {
    const sseUrl = `${baseUrl}/v1/events/stream?network=default`;
    sseReq = http.get(sseUrl, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[52hzAgents Desktop] SSE stream returned HTTP ${res.statusCode}, retrying in 5s...`);
        setTimeout(() => subscribeWorkspaceEvents(baseUrl), 5000);
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
              if (!event || !event.type) continue;

              const payload = event.payload || {};
              const targetChannel = (event.target && typeof event.target === 'string' && event.target.startsWith('channel/'))
                ? event.target.replace(/^channel\//, '')
                : 'general';

              // 1. Approval requested
              if (event.type === 'workspace.agent.approval.requested') {
                const approvalId = payload.approval_id || payload.id || event.id;
                const agentName = payload.agent_name || event.source || 'Agent';
                const action = payload.action || payload.command || 'Sensitive Operation';
                showApprovalNotification(agentName, action, approvalId);
              }

              // 2. Timer fired
              if (event.type === 'workspace.timer.fired') {
                const timer = payload.timer || {};
                const message = timer.message || '定时提醒已到期';
                const channel = timer.channel_name || targetChannel;
                showDesktopNotification({
                  title: '⏰ 定时提醒已到期',
                  body: message,
                  channel,
                });
              }

              // 3. Routine triggered
              if (event.type === 'workspace.routine.triggered') {
                const routine = payload.routine || {};
                const name = routine.name || '周期性计划任务';
                const message = routine.message || '任务已开始自动执行';
                const channel = routine.channel_name || targetChannel;
                showDesktopNotification({
                  title: `🔁 周期任务触发: ${name}`,
                  body: message,
                  channel,
                });
              }

              // 4. Routine completed
              if (event.type === 'workspace.routine.completed') {
                const routine = payload.routine || {};
                const name = payload.routine_name || routine.name || '周期性计划任务';
                const channel = payload.channel_name || routine.channel_name || targetChannel;
                showDesktopNotification({
                  title: `✅ 周期任务已完成: ${name}`,
                  body: `产出已发布至 #${channel} 频道`,
                  channel,
                });
              }

              // 5. Routine failed
              if (event.type === 'workspace.routine.failed') {
                const routine = payload.routine || {};
                const name = payload.routine_name || routine.name || '周期性计划任务';
                const errMsg = payload.error || '执行异常或超时中断';
                const channel = payload.channel_name || routine.channel_name || targetChannel;
                showDesktopNotification({
                  title: `❌ 周期任务执行失败: ${name}`,
                  body: errMsg,
                  channel,
                });
              }

              // 5. In-app notifications
              if (event.type === 'workspace.notification.created') {
                const notif = payload.notification || {};
                const channel = notif.channel_name || targetChannel;
                showDesktopNotification({
                  title: notif.title || '52hzAgents 消息提醒',
                  body: notif.message || notif.content || '',
                  channel,
                });
              }
            } catch (err) {}
          }
        }
      });
      res.on('end', () => {
        setTimeout(() => subscribeWorkspaceEvents(baseUrl), 3000);
      });
      res.on('error', () => {
        setTimeout(() => subscribeWorkspaceEvents(baseUrl), 5000);
      });
    });
    sseReq.on('error', () => {
      setTimeout(() => subscribeWorkspaceEvents(baseUrl), 5000);
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
      subscribeWorkspaceEvents('http://127.0.0.1:8000');
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
    setTimeout(() => subscribeWorkspaceEvents('http://127.0.0.1:8000'), 5000);
  });
}

function createTray() {
  try {
    const { nativeImage } = require('electron');
    const icoPath = getAssetPath('icon.ico');
    const pngPath = getAssetPath('tray-icon.png');
    let trayIcon = null;
    if (process.platform === 'win32' && fs.existsSync(icoPath)) {
      trayIcon = nativeImage.createFromPath(icoPath);
    } else if (fs.existsSync(pngPath)) {
      trayIcon = nativeImage.createFromPath(pngPath);
    }
    if (!trayIcon || trayIcon.isEmpty()) {
      console.log('[52hzAgents Desktop] Tray icon not found or empty, tray setup skipped');
      return;
    }
    tray = new Tray(trayIcon);
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
  const appIconPath = getAssetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const windowState = readWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 960,
    minHeight: 640,
    title: '52hzAgents Workspace',
    icon: appIconPath,
    backgroundColor: WINDOW_BACKGROUND,
    darkTheme: true,
    show: true,
    titleBarStyle: 'hidden',
    // On macOS the traffic lights are inset to line up with the 36px band;
    // `titleBarOverlay` is a Windows/Linux-only option and is ignored there.
    trafficLightPosition: { x: 12, y: (TITLEBAR_HEIGHT - 16) / 2 },
    titleBarOverlay: {
      color: 'rgba(0, 0, 0, 0)',
      symbolColor: '#8a8a8a',
      height: TITLEBAR_HEIGHT,
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

  if (windowState.maximized) mainWindow.maximize();

  const saveState = debounce(() => persistWindowState(mainWindow), 400);
  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('maximize', saveState);
  mainWindow.on('unmaximize', saveState);

  /*
    Tell the renderer whenever the OS has rebuilt the window's non-client area.

    `titleBarStyle: 'hidden'` means the ONLY thing that moves this window is the
    `-webkit-app-region: drag` band the renderer draws. Chromium collects those
    rectangles once and caches them, and a maximise / restore / re-show can
    leave that cache pointing at the old frame — at which point the titlebar
    looks the same and drags nothing. `AppTitlebar` listens for this and
    re-asserts the region, which forces the collection to run again.

    `show` is in the list because the close button hides the window to the tray
    rather than destroying it, so the common path back into the app is a
    `show()` rather than a fresh window.
  */
  const notifyWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state-changed');
    }
  };
  mainWindow.on('maximize', notifyWindowState);
  mainWindow.on('unmaximize', notifyWindowState);
  mainWindow.on('restore', notifyWindowState);
  mainWindow.on('show', notifyWindowState);
  mainWindow.on('enter-full-screen', notifyWindowState);
  mainWindow.on('leave-full-screen', notifyWindowState);
  // 'close' rather than 'closed': the window still has bounds to read here.
  mainWindow.on('close', () => persistWindowState(mainWindow));

  const splashHtml = `data:text/html;charset=utf-8,
    <html>
      <head><meta charset="utf-8"><title>52hzAgents Workspace</title></head>
      <body style="background:#09090b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;user-select:none;-webkit-user-select:none;overflow:hidden;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:16px;">
          <div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.12);border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;"></div>
          <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#f4f4f5;">52hzAgents Workspace</div>
          <div style="font-size:12px;color:#71717a;">正在连接本地服务...</div>
        </div>
        <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
      </body>
    </html>
  `;
  mainWindow.loadURL(splashHtml);

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

  /*
    A real menu, not `Menu.setApplicationMenu(null)`.

    Passing null removed the menu bar — which is what was wanted, the app has
    its own titlebar — but it also took every standard accelerator with it.
    Ctrl/Cmd +/-/0 did nothing, so the window had no zoom at all; Cmd+Q, Cmd+W
    and the Edit roles were gone on macOS, where they are not optional. The
    menu is built from roles and then hidden on Windows/Linux
    (`autoHideMenuBar` + `setMenuBarVisibility(false)`), which keeps the
    accelerators live without drawing a menu bar inside our titlebar.
  */
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      // Deliberately no New Chat item. A CmdOrCtrl+N accelerator here would
      // fire before the renderer's keydown handler and shadow the in-page
      // Ctrl+N the sidebar advertises.
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        // Ctrl+- only reaches the app as Ctrl+Shift+- on some layouts, so the
        // usual second binding is registered explicitly.
        { role: 'zoomOut' },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+Shift+-', visible: false },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
  if (!isMac) {
    mainWindow.setAutoHideMenuBar(true);
    mainWindow.setMenuBarVisibility(false);
  }

  /*
    Right-click. Without this there is no way to copy selected text with the
    mouse, no paste into an input, and no spelling suggestions — all three are
    things people reach for in a window without thinking, and their absence is
    read as the app being broken rather than as a missing feature.
  */
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = [];

    // `dictionarySuggestions` is documented as an array but is only populated
    // for a misspelled word in an editable field, and is absent otherwise —
    // reading `.slice` off it unguarded threw inside the handler, which
    // Electron swallows, so no menu appeared at all anywhere in the app.
    const suggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions.slice(0, 5)
      : [];
    for (const suggestion of suggestions) {
      items.push({
        label: suggestion,
        click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
      });
    }
    if (items.length) items.push({ type: 'separator' });

    if (params.linkURL) {
      items.push(
        { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy Link Address', click: () => require('electron').clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }

    if (params.isEditable) {
      items.push(
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' }, { role: 'selectAll' });
    } else {
      items.push({ role: 'selectAll' });
    }

    if (!isPackaged) {
      items.push(
        { type: 'separator' },
        { label: 'Inspect Element', click: () => mainWindow?.webContents.inspectElement(params.x, params.y) },
      );
    }

    try {
      Menu.buildFromTemplate(items).popup({ window: mainWindow });
    } catch (e) {
      // An exception thrown in this handler is swallowed by Electron, which is
      // how a bad `dictionarySuggestions` read silently disabled right-click
      // everywhere. Log rather than disappear.
      console.error('[52hzAgents] context menu failed:', e);
    }
  });


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
      } else if (retryCount < maxRetries) {
        retryCount++;
        setTimeout(loadAppUrl, 600);
      } else {
        isAppLoaded = true;
        mainWindow.loadURL(`data:text/html;charset=utf-8,
          <html>
            <body style="background:#09090b;color:#f4f4f5;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
              <h2>无法连接到 52hzAgents 本地服务</h2>
              <p style="color:#a1a1aa">目标地址: ${TARGET_URL}</p>
              <button onclick="location.reload()" style="background:#27272a;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;margin-top:16px;">重新尝试连接</button>
            </body>
          </html>
        `);
      }
    });
  }

  loadAppUrl();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file:') || url.startsWith('vscode:') || url.startsWith('cursor:')) {
      try {
        if (url.startsWith('file:')) {
          let filePath = decodeURIComponent(url.replace(/^file:\/\/\/?/i, '')).split('#')[0];
          filePath = filePath.replace(/:L\d+.*$/i, '').replace(/:\d+(?::\d+)?$/, '');
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
      const isInternal =
        (serverPort && (url.includes(`127.0.0.1:${serverPort}`) || url.includes(`localhost:${serverPort}`))) ||
        url.includes('127.0.0.1:3005') ||
        url.includes('localhost:3005') ||
        url.includes('/api/files/');
      if (isInternal) {
        return { action: 'deny' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      if (tray) {
        event.preventDefault();
        mainWindow.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
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

// OS Native Notification for Tasks, Timers, Routines & Notifications
function showDesktopNotification({ title, body, channel, silent = false }) {
  if (!Notification.isSupported()) return;

  const icoPath = getAssetPath('icon.ico');
  const pngPath = getAssetPath('tray-icon.png');
  let iconPath = undefined;
  if (process.platform === 'win32' && fs.existsSync(icoPath)) {
    iconPath = icoPath;
  } else if (fs.existsSync(pngPath)) {
    iconPath = pngPath;
  }

  const notif = new Notification({
    title: title || '52hzAgents',
    body: (body || '').slice(0, 300),
    icon: iconPath,
    silent: Boolean(silent),
  });

  notif.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (channel) {
        mainWindow.webContents.send('navigate-to-channel', channel);
      }
    }
  });

  notif.show();
}

// IPC Handlers
ipcMain.handle('show-os-notification', (event, opts) => {
  showDesktopNotification(opts || {});
  return true;
});
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
ipcMain.on('window-close', () => {
  if (tray) {
    mainWindow?.hide();
  } else {
    isQuitting = true;
    app.quit();
  }
});
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.on('window-titlebar-symbol-color', (_event, color) => {
  // `setTitleBarOverlay` is Windows/Linux-only and throws on macOS, where the
  // traffic lights follow the system appearance anyway.
  if (process.platform === 'darwin' || !mainWindow || mainWindow.isDestroyed()) return;
  // The value crosses the context bridge from the renderer, so it is validated
  // rather than passed through to a native API.
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: 'rgba(0, 0, 0, 0)',
      symbolColor: color,
      height: TITLEBAR_HEIGHT,
    });
  } catch (e) {
    console.warn('[52hzAgents] setTitleBarOverlay failed:', e.message);
  }
});

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
      const isInternal =
        (serverPort && (pathStr.includes(`127.0.0.1:${serverPort}`) || pathStr.includes(`localhost:${serverPort}`))) ||
        pathStr.includes('127.0.0.1:3005') ||
        pathStr.includes('localhost:3005') ||
        pathStr.includes('/api/files/');
      if (!isInternal) {
        shell.openExternal(pathStr);
      }
      return true;
    }
    if (pathStr.startsWith('vscode:') || pathStr.startsWith('cursor:')) {
      shell.openExternal(pathStr);
      return true;
    }
    let cleanPath = decodeURIComponent(pathStr.replace(/^file:\/\/\/?/i, '')).split('#')[0];
    cleanPath = cleanPath.replace(/:L\d+.*$/i, '').replace(/:\d+(?::\d+)?$/, '');
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(false);
    }
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
