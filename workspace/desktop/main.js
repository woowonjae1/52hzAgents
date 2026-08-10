const { app, BrowserWindow, Menu, Tray, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let devServerProcess = null;

const TARGET_URL = process.env.FRONTEND_URL || 'http://localhost:3005';

function checkServerReady(url, callback) {
  const req = http.get(url, (res) => {
    if (res.statusCode === 200 || res.statusCode === 304) {
      callback(true);
    } else {
      callback(false);
    }
  });
  req.on('error', () => callback(false));
  req.setTimeout(2000, () => {
    req.destroy();
    callback(false);
  });
}

function ensureDevStackRunning() {
  checkServerReady(TARGET_URL, (ready) => {
    if (!ready) {
      console.log('[52hzAgents Desktop] Dev stack not detected on 3005. Starting backend dev-sqlite.ps1...');
      const scriptPath = path.resolve(__dirname, '../dev-sqlite.ps1');
      devServerProcess = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        cwd: path.resolve(__dirname, '..'),
        detached: true,
        stdio: 'ignore',
      });
      devServerProcess.unref();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '52hzAgents Workspace',
    backgroundColor: '#0e0e10',
    darkTheme: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // Remove default window menu for sleek native app look
  Menu.setApplicationMenu(null);

  let retryCount = 0;
  const maxRetries = 60; // 60 attempts (approx 60s)

  function loadAppUrl() {
    checkServerReady(TARGET_URL, (ready) => {
      if (ready) {
        mainWindow.loadURL(TARGET_URL);
        mainWindow.show();
      } else if (retryCount < maxRetries) {
        retryCount++;
        setTimeout(loadAppUrl, 1000);
      } else {
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

  // External links open in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Keyboard shortcuts (F5 / Ctrl+R reload, F12 / Ctrl+Shift+I devtools)
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  ensureDevStackRunning();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
