"use strict";
const electron = require("electron");
const backendUrlArg = process.argv.find((arg) => arg.startsWith("--backend-url="));
const desktopBackendUrl = backendUrlArg ? backendUrlArg.split("=")[1] : "http://localhost:8000";
electron.contextBridge.exposeInMainWorld("electronBridge", {
  getApiUrl: () => desktopBackendUrl,
  getWorkspaceToken: (slug) => {
    if (!slug) {
      console.warn("[electronBridge] getWorkspaceToken requires an explicit workspace slug.");
      return Promise.resolve(null);
    }
    return electron.ipcRenderer.invoke("workspace:get-token", slug);
  },
  isDesktop: true
});
