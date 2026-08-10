const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isDesktop: true,
  platform: process.platform,
});
