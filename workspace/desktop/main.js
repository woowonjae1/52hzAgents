const { app, BrowserWindow, Menu, Tray, shell, globalShortcut, ipcMain, Notification, dialog, clipboard, powerMonitor, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { startServer } = require('./server');

const isWindows11 = process.platform === 'win32' && parseInt((os.release() || '').split('.')[2], 10) >= 22000;

// Disable hardware acceleration to guarantee 100% stability across all Windows GPU drivers / VMs
app.disableHardwareAcceleration();

// 1. Isolate userData folder
try {
  const customUserData = path.join(app.getPath('appData'), '52hzAgents-Desktop');
  app.setPath('userData', customUserData);
} catch (e) {}

// Diagnostic File Logger
const LOGS_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'app.log');
function logToFile(level, ...args) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {}
}

// Register Custom URL Scheme (52hzagents://)
try {
  app.setAsDefaultProtocolClient('52hzagents');
} catch (e) {
  logToFile('WARN', 'Failed to register protocol client:', e.message);
}

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
const TITLEBAR_HEIGHT = 40;

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
let embeddedServer = null;
let sseReq = null;

// Production / Development Configuration
const isPackaged = app.isPackaged;
const devToolsEnabled =
  !app.isPackaged ||
  process.env.OPENAGENTS_DEVTOOLS === '1' ||
  process.argv.includes('--devtools');
const DEFAULT_PORT = parseInt(process.env.API_PORT || process.env.PORT || '8000', 10);
let serverPort = DEFAULT_PORT;
let TARGET_URL = `http://127.0.0.1:${DEFAULT_PORT}/`;

/**
 * Window geometry, remembered across launches.
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
    const { x, y, width, height } = win.getNormalBounds();
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ x, y, width, height, maximized: win.isMaximized() }),
    );
  } catch {}
}

const ZOOM_STATE_FILE = path.join(app.getPath('userData'), 'zoom-state.json');

function readZoomLevel() {
  try {
    const raw = JSON.parse(fs.readFileSync(ZOOM_STATE_FILE, 'utf8'));
    const level = Number(raw.zoomLevel);
    return Number.isFinite(level) ? Math.max(-5, Math.min(5, level)) : 0;
  } catch {
    return 0;
  }
}

function persistZoomLevel(level) {
  try {
    fs.writeFileSync(ZOOM_STATE_FILE, JSON.stringify({ zoomLevel: level }));
  } catch {}
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

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

/**
 * Start the Embedded Native Node Backend Server.
 * Replaces the heavy Go backend and external wwj daemon completely.
 */
async function startEmbeddedBackend() {
  const userData = app.getPath('userData');
  const possiblePublicPaths = [
    path.join(process.resourcesPath, 'public'),
    path.join(__dirname, 'resources', 'public'),
    path.join(__dirname, '..', 'frontend', 'out'),
  ];
  const staticDir = possiblePublicPaths.find((p) => fs.existsSync(p)) || path.join(__dirname, 'resources', 'public');
  console.log(`[52hzAgents Desktop] Serving frontend from: ${staticDir}`);

  serverPort = await findFreePort(DEFAULT_PORT);
  TARGET_URL = `http://127.0.0.1:${serverPort}/`;
  console.log(`[52hzAgents Desktop] Selected port: ${serverPort}`);

  const { server } = await startServer({
    port: serverPort,
    userDataPath: userData,
    staticDir,
  });
  embeddedServer = server;

  // Subscribe to live SSE events for workspace notifications and approvals
  setTimeout(() => subscribeWorkspaceEvents(`http://127.0.0.1:${serverPort}`), 400);
}

async function subscribeWorkspaceEvents(baseUrl) {
  try {
    if (sseReq) {
      try { sseReq.destroy(); } catch (_) {}
      sseReq = null;
    }
    const sseUrl = `${baseUrl}/v1/events/stream`;
    sseReq = http.get(sseUrl, (res) => {
      if (res.statusCode !== 200) {
        setTimeout(() => subscribeWorkspaceEvents(baseUrl), 5000);
        return;
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
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
                const message = timer.message || '定时提醒已到达';
                const channel = timer.channel_name || targetChannel;
                showDesktopNotification({
                  title: '⏰ 定时提醒已到达',
                  body: message,
                  channel,
                });
              }

              // 3. Routine completed
              if (event.type === 'workspace.routine.completed') {
                const routine = payload.routine || {};
                const name = payload.routine_name || routine.name || '周期性计划任务';
                const channel = payload.channel_name || routine.channel_name || targetChannel;
                showDesktopNotification({
                  title: `🔄 周期任务已完成: ${name}`,
                  body: `产出已发布至 #${channel} 频道`,
                  channel,
                });
              }

              // 4. In-app notifications
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
        if (!isQuitting) setTimeout(() => subscribeWorkspaceEvents(baseUrl), 3000);
      });
      res.on('error', () => {
        if (!isQuitting) setTimeout(() => subscribeWorkspaceEvents(baseUrl), 5000);
      });
    });
    sseReq.on('error', () => {
      if (!isQuitting) setTimeout(() => subscribeWorkspaceEvents(baseUrl), 5000);
    });
  } catch (e) {}
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show 52hzAgent Studio',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Quick Bar',
      accelerator: 'Alt+Space',
      click: () => toggleQuickBar(),
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        buildTrayMenu();
      },
    },
    {
      label: 'Copy Window Diagnostics',
      click: () => copyDiagnostics(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function applyUnreadCount(count, overlayDataUrl) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  try {
    app.setBadgeCount(n);
  } catch (e) {}

  if (tray && !tray.isDestroyed()) {
    try {
      tray.setToolTip(n > 0 ? `52hzAgent Studio — ${n} unread` : '52hzAgent Studio');
    } catch (_) {}
  }

  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (n === 0 || !overlayDataUrl) {
      mainWindow.setOverlayIcon(null, '');
      return;
    }
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromDataURL(overlayDataUrl);
    if (image.isEmpty()) return;
    mainWindow.setOverlayIcon(image, `${n} unread`);
  } catch (e) {
    console.warn('[52hzAgents] overlay icon failed:', e.message);
  }
}

async function copyDiagnostics() {
  const { clipboard, screen } = require('electron');
  try {
    const fromRenderer = await mainWindow.webContents.executeJavaScript(`(() => {
      const wco = navigator.windowControlsOverlay;
      const r = wco && wco.visible ? wco.getTitlebarAreaRect() : null;
      const cs = getComputedStyle(document.documentElement);
      const el = document.elementFromPoint(window.innerWidth - 30, 18);
      const describe = (n) => n ? (n.tagName.toLowerCase()
        + (n.id ? '#' + n.id : '')
        + (typeof n.className === 'string' && n.className.trim()
            ? '.' + n.className.trim().split(' ').filter(Boolean).slice(0, 5).join('.')
            : '')) : null;
      return {
        wcoVisible: !!(wco && wco.visible),
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        innerWidth: window.innerWidth,
        measuredInset: r ? Math.round(window.innerWidth - (r.x + r.width)) : null,
        cssInset: cs.getPropertyValue('--window-controls-inset').trim(),
        cssTitlebarHeight: cs.getPropertyValue('--titlebar-height').trim(),
        devicePixelRatio: window.devicePixelRatio,
        underCloseButton: describe(el),
        underCloseButtonParent: describe(el && el.parentElement),
      };
    })()`);
    const display = screen.getPrimaryDisplay();
    clipboard.writeText(JSON.stringify({
      ...fromRenderer,
      packaged: isPackaged,
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      displayScaleFactor: display.scaleFactor,
      displaySize: `${display.size.width}x${display.size.height}`,
      windowBounds: mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
      titlebarHeightConstant: TITLEBAR_HEIGHT,
      windowControlsInsetConstant: 138,
    }, null, 2));
    if (Notification.isSupported()) {
      new Notification({
        title: '52hzAgent Studio',
        body: 'Window diagnostics copied to clipboard',
      }).show();
    }
  } catch (e) {
    clipboard.writeText(`diagnostics failed: ${e && e.message}`);
  }
}

function createTray() {
  try {
    const { nativeImage } = require('electron');
    const pngPath = getAssetPath('tray-icon.png');
    const icoPath = getAssetPath('icon.ico');
    let trayIcon = null;

    if (fs.existsSync(pngPath)) {
      trayIcon = nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 });
    } else if (fs.existsSync(icoPath)) {
      trayIcon = nativeImage.createFromPath(icoPath).resize({ width: 16, height: 16 });
    }

    if (trayIcon && !trayIcon.isEmpty()) {
      tray = new Tray(trayIcon);
      try { tray.setToolTip('52hzAgent Studio'); } catch (_) {}
      buildTrayMenu();

      tray.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.focus();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      });
    }
  } catch (e) {
    console.log('[52hzAgents Desktop] Tray setup skipped:', e.message);
    tray = null;
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
    title: '52hzAgent Studio',
    icon: appIconPath,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : WINDOW_BACKGROUND,
    darkTheme: true,
    show: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' } : {}),
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
      sandbox: false,
      webSecurity: true,
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      try {
        if (process.platform === 'win32') {
          mainWindow.setOverlayIcon(null, '');
        }
      } catch {}
    }
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 1000);

  const initialZoom = readZoomLevel();
  if (initialZoom !== 0) {
    mainWindow.webContents.setZoomLevel(initialZoom);
  }
  const saveZoom = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      persistZoomLevel(mainWindow.webContents.getZoomLevel());
    }
  };
  mainWindow.webContents.on('zoom-changed', saveZoom);
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (!(input.control || input.meta) || input.type !== 'keyUp') return;
    if (['=', '+', '-', '_', '0'].includes(input.key)) saveZoom();
  });

  const saveState = debounce(() => persistWindowState(mainWindow), 400);
  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('maximize', saveState);
  mainWindow.on('unmaximize', saveState);

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
  mainWindow.on('close', () => persistWindowState(mainWindow));

  // Directly load the embedded local URL
  mainWindow.loadURL(TARGET_URL);

  // Download lifecycle
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    item.on('updated', (_evt, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const percent = total > 0 ? Math.round((received / total) * 100) : 0;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setProgressBar(total > 0 ? received / total : 0.5);
          mainWindow.webContents.send('download-progress', {
            filename,
            received,
            total,
            percent,
          });
        }
      } else if (state === 'interrupted') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setProgressBar(-1);
          mainWindow.webContents.send('download-failed', { filename, state: 'interrupted' });
        }
      }
    });

    item.once('done', (_evt, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(-1);
        if (state === 'completed') {
          const savePath = item.getSavePath();
          mainWindow.webContents.send('download-complete', { filename, savePath });
        } else if (state === 'cancelled') {
          mainWindow.webContents.send('download-cancelled', { filename });
        } else {
          mainWindow.webContents.send('download-failed', { filename, state });
        }
      }
    });
  });

  const isMac = process.platform === 'darwin';
  const command = (label, id, accelerator) => ({
    label,
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    click: () => mainWindow?.webContents.send('menu-command', id),
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        command('New Chat', 'new-chat'),
        command('Command Palette…', 'palette', 'CmdOrCtrl+K'),
        { type: 'separator' },
        command('Settings…', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        command('Threads', 'go:threads'),
        command('Tasks', 'go:tasks'),
        command('Agent Dashboard', 'go:mission'),
        command('Files', 'go:files'),
        command('Knowledge', 'go:knowledge'),
        command('Skills', 'go:skills'),
        command('Routines', 'go:routines'),
        command('Inbox', 'go:inbox'),
        command('Browser', 'go:browser'),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(devToolsEnabled ? [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
        ] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+Shift+-', visible: false },
        { type: 'separator' },
        command('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        command('Toggle Studio Panel', 'toggle-studio', 'CmdOrCtrl+\\'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        command('Keyboard Shortcuts', 'shortcuts', '?'),
        { type: 'separator' },
        {
          label: 'Open Logs Folder',
          click: () => {
            if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
            shell.openPath(LOGS_DIR);
          },
        },
        {
          label: 'Documentation & GitHub',
          click: () => shell.openExternal('https://github.com/woowonjae1/52hzAgents'),
        },
      ],
    },
  ]));

  if (!isMac) {
    mainWindow.setAutoHideMenuBar(true);
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' }, { role: 'selectAll' });
    } else {
      items.push({ role: 'selectAll' });
    }
    if (devToolsEnabled) {
      items.push(
        { type: 'separator' },
        { label: 'Inspect Element', click: () => mainWindow?.webContents.inspectElement(params.x, params.y) },
      );
    }
    try {
      Menu.buildFromTemplate(items).popup({ window: mainWindow });
    } catch (_) {}
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!devToolsEnabled) {
      if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
        event.preventDefault();
      }
      return;
    }
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

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
          shell.openPath(filePath);
        } else {
          shell.openExternal(url);
        }
      } catch (e) {
        console.error('[52hzAgents] Failed to open link:', e);
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
    logToFile('INFO', 'mainWindow on close event, isQuitting:', isQuitting, 'hasTray:', Boolean(tray));
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
      sandbox: false,
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

function positionQuickBar() {
  if (!quickBarWindow || quickBarWindow.isDestroyed()) return;
  try {
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = currentDisplay.workArea;
    const [qWidth] = quickBarWindow.getSize();
    const targetX = Math.round(x + (width - qWidth) / 2);
    const targetY = Math.round(y + height * 0.24);
    quickBarWindow.setPosition(targetX, targetY, false);
  } catch (e) {
    console.warn('[QuickBar] Failed to calculate screen position:', e);
  }
}

function toggleQuickBar() {
  if (!quickBarWindow || quickBarWindow.isDestroyed()) {
    createQuickBarWindow();
  }
  if (quickBarWindow.isVisible()) {
    quickBarWindow.hide();
  } else {
    positionQuickBar();
    quickBarWindow.show();
    quickBarWindow.focus();
  }
}

function showApprovalNotification(agentName, action, approvalId) {
  if (!Notification.isSupported()) return;
  const isWin = process.platform === 'win32';
  const notif = new Notification({
    title: `52hzAgents: 审批请求`,
    body: `Agent @${agentName} 请求执行: ${action}${isWin ? ' (点击前往处理)' : ''}`,
  });
  notif.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(false);
      mainWindow.webContents.send('navigate-approval', { approvalId, agentName, action });
    }
  });
  notif.show();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
}

const recentDesktopNotifs = new Map();
function showDesktopNotification({ title, body, channel, silent = false }) {
  if (!Notification.isSupported()) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
    return;
  }
  const notifKey = `${title || ''}::${body || ''}`;
  const now = Date.now();
  if (recentDesktopNotifs.has(notifKey) && now - recentDesktopNotifs.get(notifKey) < 15000) {
    return;
  }
  recentDesktopNotifs.set(notifKey, now);

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
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(false);
      if (channel) {
        mainWindow.webContents.send('navigate-to-channel', channel);
      }
    }
  });

  notif.show();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused() && !silent) {
    mainWindow.flashFrame(true);
  }
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
  event.returnValue = `http://127.0.0.1:${serverPort || DEFAULT_PORT}`;
});
ipcMain.handle('get-api-url', () => `http://127.0.0.1:${serverPort || DEFAULT_PORT}`);
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
  if (process.platform === 'darwin' || !mainWindow || mainWindow.isDestroyed()) return;
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

ipcMain.on('window-theme-changed', (_event, theme) => {
  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    try {
      nativeTheme.themeSource = theme;
    } catch (e) {
      console.warn('[52hzAgents] theme sync failed:', e.message);
    }
  }
});

ipcMain.on('window-set-progress-bar', (_event, progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(typeof progress === 'number' ? progress : -1);
  }
});

ipcMain.on('window-flash-frame', (_event, flag) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(Boolean(flag));
  }
});

ipcMain.on('quickbar:resize-height', (_event, height) => {
  if (!quickBarWindow || quickBarWindow.isDestroyed()) return;
  const clampedHeight = Math.max(100, Math.min(560, Math.round(height)));
  const [w, h] = quickBarWindow.getSize();
  if (h !== clampedHeight) {
    quickBarWindow.setSize(w, clampedHeight);
  }
});

ipcMain.handle('clipboard-write-text', (_event, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('quickbar-hide', () => {
  if (quickBarWindow && !quickBarWindow.isDestroyed()) {
    quickBarWindow.hide();
  }
});
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
  buildTrayMenu();
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('set-unread-count', (_event, payload) => {
  const { count, overlayDataUrl } = payload || {};
  applyUnreadCount(count, overlayDataUrl);
});

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

ipcMain.handle('shell-open-path', async (event, pathStr) => {
  if (!pathStr) return false;
  try {
    if (pathStr.startsWith('http://') || pathStr.startsWith('https://')) {
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
    if (!fs.existsSync(cleanPath)) return false;
    const err = await shell.openPath(cleanPath);
    if (!err) return true;
    shell.showItemInFolder(cleanPath);
    return true;
  } catch (e) {
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
      cleanPath = cleanPath.replace(/\//g, '\\');
    }
    shell.showItemInFolder(cleanPath);
    return true;
  } catch (e) {
    return false;
  }
});

process.on('uncaughtException', (err) => {
  logToFile('CRASH', 'uncaughtException:', err.stack || err.message);
  console.error('[52hzAgents UncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  logToFile('CRASH', 'unhandledRejection:', reason);
  console.error('[52hzAgents UnhandledRejection]', reason);
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logToFile('INFO', 'Did not get single instance lock, quitting duplicate process.');
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(false);

      const urlArg = commandLine && commandLine.find((arg) => typeof arg === 'string' && arg.startsWith('52hzagents://'));
      if (urlArg && mainWindow.webContents) {
        mainWindow.webContents.send('open-protocol-url', urlArg);
      }
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      if (mainWindow.webContents) {
        mainWindow.webContents.send('open-protocol-url', url);
      }
    }
  });
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.52hzagents.app');
  }

  if (powerMonitor) {
    powerMonitor.on('resume', () => {
      logToFile('INFO', 'System resumed from sleep');
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('power-monitor-resume');
      }
    });
  }

  // 1. Start embedded lean server
  await startEmbeddedBackend();

  // 2. Open frameless window & UI
  createMainWindow();
  createQuickBarWindow();
  createTray();

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

app.on('before-quit', (e) => {
  logToFile('INFO', 'app before-quit triggered');
  isQuitting = true;
  if (sseReq) {
    try { sseReq.destroy(); } catch (_) {}
  }
  if (embeddedServer) {
    try { embeddedServer.close(); } catch (_) {}
  }
});

app.on('will-quit', () => {
  logToFile('INFO', 'app will-quit triggered');
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  logToFile('INFO', 'app window-all-closed triggered');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
