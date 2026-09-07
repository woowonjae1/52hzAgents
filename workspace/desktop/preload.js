const { contextBridge, ipcRenderer } = require('electron');

let cachedDesktopApiUrl = null;

contextBridge.exposeInMainWorld('electronBridge', {
  isDesktop: true,
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  // Recolours the native caption-button glyphs when the app theme changes.
  // The overlay is drawn by the OS, so CSS cannot reach it — without this the
  // buttons keep one fixed grey and go low-contrast in light mode.
  setTitleBarSymbolColor: (color) => ipcRenderer.send('window-titlebar-symbol-color', color),
  hideQuickBar: () => ipcRenderer.send('quickbar-hide'),
  openMainWindow: (route) => ipcRenderer.send('main-window-open', route),
  getAutostart: () => ipcRenderer.invoke('app-get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('app-set-autostart', enabled),
  getApiUrl: () => {
    if (cachedDesktopApiUrl) return cachedDesktopApiUrl;
    cachedDesktopApiUrl = ipcRenderer.sendSync('get-api-url-sync');
    return cachedDesktopApiUrl;
  },
  browseFolder: (defaultPath) => ipcRenderer.invoke('dialog-open-folder', defaultPath),
  openPath: (pathStr) => ipcRenderer.invoke('shell-open-path', pathStr),
  showItemInFolder: (pathStr) => ipcRenderer.invoke('shell-show-item', pathStr),
});

