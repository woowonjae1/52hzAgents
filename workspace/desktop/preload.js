const { contextBridge, ipcRenderer } = require('electron');

let cachedDesktopApiUrl = null;

/** One-argument IPC subscription that hands back its own unsubscribe. */
function subscribe(channel, handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

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
  /**
   * Push the unread count out to the OS — dock badge, Windows taskbar overlay,
   * tray tooltip. `overlayDataUrl` is drawn by the renderer because the main
   * process has no canvas to render a number into.
   */
  setUnreadCount: (count, overlayDataUrl) =>
    ipcRenderer.send('set-unread-count', { count, overlayDataUrl }),

  /**
   * Download lifecycle, so the renderer can say "saved" and offer to reveal the
   * file instead of clicking an invisible anchor and hoping.
   *
   * Each returns its own unsubscribe. `removeListener` with the same wrapper is
   * what makes that work — `removeAllListeners` here would tear down every
   * other subscriber in the app.
   */
  onDownloadProgress: (handler) => subscribe('download-progress', handler),
  onDownloadComplete: (handler) => subscribe('download-complete', handler),
  onDownloadCancelled: (handler) => subscribe('download-cancelled', handler),
  onDownloadFailed: (handler) => subscribe('download-failed', handler),

  /** Menu-bar items that run an in-app command. See main.js `command()`. */
  onMenuCommand: (handler) => subscribe('menu-command', handler),

  onNavigateToChannel: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (event, channel) => handler(channel);
    ipcRenderer.on('navigate-to-channel', listener);
    return () => ipcRenderer.removeListener('navigate-to-channel', listener);
  },
});

