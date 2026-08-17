const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isDesktop: true,
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  hideQuickBar: () => ipcRenderer.send('quickbar-hide'),
  openMainWindow: (route) => ipcRenderer.send('main-window-open', route),
  getAutostart: () => ipcRenderer.invoke('app-get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('app-set-autostart', enabled),
  browseFolder: (defaultPath) => ipcRenderer.invoke('dialog-open-folder', defaultPath),
});

