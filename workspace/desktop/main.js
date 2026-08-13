const { app, BrowserWindow, Menu, Tray, shell, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// 1. Isolate userData folder & disable GPU shader cache lock (0x5)
try {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
  const customUserData = path.join(app.getPath('appData'), '52hzAgents-Desktop');
  app.setPath('userData', customUserData);
} catch (e) {}

let mainWindow = null;
let tray = null;
let isQuitting = false;

const TARGET_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:3005/';

function checkServerReady(url, callback) {
  const testUrl = url.replace('localhost', '127.0.0.1');
  const req = http.get(testUrl, (res) => {
    if (res.statusCode && res.statusCode < 400) {
      callback(true);
    } else {
      callback(false);
    }
  });
  req.on('error', () => callback(false));
  req.setTimeout(3000, () => {
    req.destroy();
    callback(false);
  });
}

// Once per app run, and never again. This used to spawn a stack on every
// readiness check that happened to fail, and dev-sqlite.ps1 begins by killing
// whatever stack is already running — so a single blip (a restart, a slow
// compile) turned into a loop: probe fails, spawn, the new script kills the
// stack that was coming up, the next probe fails, spawn again. The window sat
// on "Loading your workspace…" the whole time, reloading.
let devStackSpawned = false;

function ensureDevStackRunning() {
  checkServerReady(TARGET_URL, (ready) => {
    if (ready) {
      console.log('[52hzAgents Desktop] Connected to local server at 127.0.0.1:3005.');
      return;
    }
    if (devStackSpawned) {
      console.log('[52hzAgents Desktop] Dev stack already starting — waiting, not spawning another.');
      return;
    }
    devStackSpawned = true;
    console.log('[52hzAgents Desktop] Starting dev-sqlite.ps1 stack...');
    const scriptPath = path.resolve(__dirname, '../dev-sqlite.ps1');
    const devServerProcess = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: path.resolve(__dirname, '..'),
      detached: true,
      stdio: 'ignore',
    });
    devServerProcess.unref();
  });
}

function createTray() {
  try {
    // Basic text/blank tray fallback if icon file is pending
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
        label: '隐藏到托盘',
        click: () => {
          if (mainWindow) mainWindow.hide();
        },
      },
      { type: 'separator' },
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
    },
  });

  Menu.setApplicationMenu(null);

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
              <h2>Unable to connect to 52hzAgents Web Server</h2>
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

  // External links open in default browser, internal app URLs navigate inside window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:3005') || url.startsWith('http://localhost:3005')) {
      return { action: 'allow' };
    }
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Short-cut keys: F5 / Ctrl+R reload, F12 toggle DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
        mainWindow.reload();
        event.preventDefault();
      } else if (input.key === 'F5') {
        mainWindow.reload();
        event.preventDefault();
      } else if (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
  });

  // Minimize to tray on close
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

// IPC Handlers
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.hide());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// One app, one instance. Nothing in this file reloads the window — loadAppUrl()
// runs once — so the same URL getting loaded over and over can only come from
// another instance. And closing the window merely hides it (tray + the 'close'
// handler below), so every extra `start-desktop.ps1` run left a live instance
// behind, each loading http://127.0.0.1:3005/ on its own schedule and each
// bouncing through the workspace picker. Hand the launch to the instance that is
// already running instead of starting a rival.
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

app.whenReady().then(() => {
  if (!gotTheLock) return;
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.52hzagents.app');
  }
  ensureDevStackRunning();
  createMainWindow();
  createTray();

  // Register Global Hotkey (Alt + Space) to toggle desktop app anywhere on OS
  try {
    globalShortcut.register('Alt+Space', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
