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
  /**
   * Fires after the window is maximised, unmaximised, restored or re-shown.
   *
   * The renderer needs to know because Chromium caches the rectangles it
   * collected from `-webkit-app-region: drag` and does not always recollect
   * them when the OS changes the window's non-client area underneath it. When
   * that cache goes stale the titlebar stops moving the window — see
   * `AppTitlebar`, which re-asserts the region on this signal.
   */
  onWindowStateChanged: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = () => handler();
    ipcRenderer.on('window-state-changed', listener);
    return () => ipcRenderer.removeListener('window-state-changed', listener);
  },
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
  showNotification: (opts) => ipcRenderer.invoke('show-os-notification', opts),
  onNavigateToChannel: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (event, channel) => handler(channel);
    ipcRenderer.on('navigate-to-channel', listener);
    return () => ipcRenderer.removeListener('navigate-to-channel', listener);
  },
});

