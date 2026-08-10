"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  pythonStatus: () => electron.ipcRenderer.invoke("python:status"),
  installSDK: () => electron.ipcRenderer.invoke("python:install"),
  runtimeInfo: () => electron.ipcRenderer.invoke("runtime:info"),
  listAgents: () => electron.ipcRenderer.invoke("agents:list"),
  getSupportedAgentTypes: () => electron.ipcRenderer.invoke("agents:supported-types"),
  getAgentCoreInfo: () => electron.ipcRenderer.invoke("agents:core-info"),
  addAgent: (config) => electron.ipcRenderer.invoke("agents:add", config),
  removeAgent: (name) => electron.ipcRenderer.invoke("agents:remove", name),
  updateAgent: (name, config) => electron.ipcRenderer.invoke("agents:update", name, config),
  setAgentWorkingDir: (name, dir) => electron.ipcRenderer.invoke("agents:set-workdir", name, dir),
  startAgent: (name) => electron.ipcRenderer.invoke("agents:start", name),
  stopAgent: (name) => electron.ipcRenderer.invoke("agents:stop", name),
  startAll: () => electron.ipcRenderer.invoke("agents:start-all"),
  stopAll: () => electron.ipcRenderer.invoke("agents:stop-all"),
  agentStatus: () => electron.ipcRenderer.invoke("agents:status"),
  agentLogs: (name, lines) => electron.ipcRenderer.invoke("agents:logs", name, lines),
  tailAgentLogs: (name, lines, offset) => electron.ipcRenderer.invoke("agents:tail-logs", name, lines, offset),
  clearLogsInRange: (start, end) => electron.ipcRenderer.invoke("agents:clear-logs-range", start, end),
  installAgentType: (type) => electron.ipcRenderer.invoke("agents:install-type", type),
  installAgentTypeStreaming: (type) => electron.ipcRenderer.invoke("agents:install-type-streaming", type),
  onInstallOutput: (callback) => electron.ipcRenderer.on("install:output", (_e, data) => callback(data)),
  removeInstallOutputListener: () => electron.ipcRenderer.removeAllListeners("install:output"),
  onInstallProgress: (callback) => electron.ipcRenderer.on("install:progress", (_e, ev) => callback(ev)),
  removeInstallProgressListener: () => electron.ipcRenderer.removeAllListeners("install:progress"),
  uninstallAgentType: (type) => electron.ipcRenderer.invoke("agents:uninstall-type", type),
  uninstallAgentTypeStreaming: (type) => electron.ipcRenderer.invoke("agents:uninstall-type-streaming", type),
  checkAgentType: (type) => electron.ipcRenderer.invoke("agents:check-type", type),
  getCatalog: (force) => electron.ipcRenderer.invoke("agents:catalog", !!force),
  getInstalledAgents: () => electron.ipcRenderer.invoke("agents:installed-list"),
  checkAgentUpdates: () => electron.ipcRenderer.invoke("agents:check-updates"),
  rollbackAgentType: (type) => electron.ipcRenderer.invoke("agents:rollback", type),
  installAgentTypeAtVersionStreaming: (type, target) => electron.ipcRenderer.invoke("agents:install-at-version-streaming", type, target),
  getAgentChangelog: (type) => electron.ipcRenderer.invoke("agents:changelog", type),
  getEnvFields: (type) => electron.ipcRenderer.invoke("agents:env-fields", type),
  getAgentEnv: (type) => electron.ipcRenderer.invoke("agents:get-env", type),
  saveAgentEnv: (type, env) => electron.ipcRenderer.invoke("agents:save-env", type, env),
  deleteAgentEnv: (type) => electron.ipcRenderer.invoke("agents:delete-env", type),
  getAgentInstanceEnv: (name) => electron.ipcRenderer.invoke("agents:get-instance-env", name),
  saveAgentInstanceEnv: (name, env) => electron.ipcRenderer.invoke("agents:save-instance-env", name, env),
  testLLM: (env) => electron.ipcRenderer.invoke("agents:test-llm", env),
  signalReload: () => electron.ipcRenderer.invoke("agents:signal-reload"),
  connectWorkspace: (agentName, slug) => electron.ipcRenderer.invoke("workspace:connect", agentName, slug),
  disconnectWorkspace: (agentName) => electron.ipcRenderer.invoke("workspace:disconnect", agentName),
  removeWorkspace: (slug) => electron.ipcRenderer.invoke("workspace:remove", slug),
  listWorkspaces: () => electron.ipcRenderer.invoke("workspace:list"),
  createWorkspace: (name) => electron.ipcRenderer.invoke("workspace:create", name),
  getOnboardingAgents: () => electron.ipcRenderer.invoke("onboarding:agents"),
  consumeOnboardingReset: () => electron.ipcRenderer.invoke("onboarding:consume-reset"),
  provisionFirstAgent: (opts) => electron.ipcRenderer.invoke("onboarding:provision", opts),
  registerWorkspaceFromToken: (input) => electron.ipcRenderer.invoke("workspace:register-from-token", input),
  getSetting: (key) => electron.ipcRenderer.invoke("settings:get", key),
  setSetting: (key, value) => electron.ipcRenderer.invoke("settings:set", key, value),
  getAllSettings: () => electron.ipcRenderer.invoke("settings:get-all"),
  exportSettings: () => electron.ipcRenderer.invoke("settings:export"),
  importSettings: (json) => electron.ipcRenderer.invoke("settings:import", json),
  resetSettings: () => electron.ipcRenderer.invoke("settings:reset"),
  listPaths: () => electron.ipcRenderer.invoke("paths:list"),
  showPath: (p) => electron.ipcRenderer.invoke("paths:show", p),
  selectDirectory: (defaultPath) => electron.ipcRenderer.invoke("dialog:select-directory", defaultPath),
  healthCheck: (type) => electron.ipcRenderer.invoke("agents:health-check", type),
  refreshLogin: (type) => electron.ipcRenderer.invoke("agents:login-refresh", type),
  clearLoginKey: (type, agentName) => electron.ipcRenderer.invoke("agents:login-clear-key", type, agentName),
  openExternal: (url) => electron.ipcRenderer.invoke("shell:open-external", url),
  shellExec: (cmd) => electron.ipcRenderer.invoke("shell:exec", cmd),
  openTerminal: (cmd) => electron.ipcRenderer.invoke("shell:open-terminal", cmd),
  openAgentTerminal: (agentName) => electron.ipcRenderer.invoke("shell:open-agent-terminal", agentName),
  updateCore: () => electron.ipcRenderer.invoke("core:update"),
  // ── Launcher self-update ──
  getUpdaterState: () => electron.ipcRenderer.invoke("updater:get-state"),
  checkLauncherUpdate: () => electron.ipcRenderer.invoke("updater:check"),
  downloadLauncherUpdate: () => electron.ipcRenderer.invoke("updater:download"),
  installLauncherUpdate: () => electron.ipcRenderer.invoke("updater:install"),
  onUpdaterEvent: (cb) => {
    const handler = (_e, state) => cb(state);
    electron.ipcRenderer.on("updater:event", handler);
    return () => electron.ipcRenderer.removeListener("updater:event", handler);
  },
  onCoreUpdate: (cb) => electron.ipcRenderer.on("core-update-available", (_e, info) => cb(info)),
  onAgentUpdatesChanged: (cb) => electron.ipcRenderer.on("agent-updates-changed", (_e, updates) => cb(updates)),
  onNavigateToInstall: (cb) => electron.ipcRenderer.on("navigate-to-install", (_e, name) => cb(name)),
  getIconPath: (name) => electron.ipcRenderer.invoke("icons:get-path", name),
  getIconsDir: () => electron.ipcRenderer.invoke("icons:get-dir"),
  debugEnv: () => electron.ipcRenderer.invoke("debug:env"),
  // ── Chat ──
  chatSendMessage: (input) => electron.ipcRenderer.invoke("workspace:send-message", input),
  chatGetMessages: (workspaceId, channelName, limit) => electron.ipcRenderer.invoke("workspace:get-messages", workspaceId, channelName, limit),
  chatStartPolling: (workspaceId, channelName) => electron.ipcRenderer.invoke("workspace:start-polling", workspaceId, channelName),
  chatStopPolling: (workspaceId, channelName) => electron.ipcRenderer.invoke("workspace:stop-polling", workspaceId, channelName),
  chatListParticipants: (workspaceId) => electron.ipcRenderer.invoke("workspace:list-participants", workspaceId),
  onChatEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    electron.ipcRenderer.on("chat:event", handler);
    return () => electron.ipcRenderer.removeListener("chat:event", handler);
  },
  // ── Files ──
  chatUploadFile: (workspaceId, filename, contentBase64, opts) => electron.ipcRenderer.invoke("workspace:upload-file", workspaceId, filename, contentBase64, opts),
  chatListFiles: (workspaceId, opts) => electron.ipcRenderer.invoke("workspace:list-files", workspaceId, opts),
  chatReadFile: (workspaceId, fileId) => electron.ipcRenderer.invoke("workspace:read-file", workspaceId, fileId),
  chatDeleteFile: (workspaceId, fileId) => electron.ipcRenderer.invoke("workspace:delete-file", workspaceId, fileId),
  // ── Sessions ──
  sessionList: (workspaceId) => electron.ipcRenderer.invoke("session:list", workspaceId),
  sessionCreate: (workspaceId) => electron.ipcRenderer.invoke("session:create", workspaceId),
  sessionLoad: (workspaceId, channelName) => electron.ipcRenderer.invoke("session:load", workspaceId, channelName),
  sessionDelete: (workspaceId, channelName) => electron.ipcRenderer.invoke("session:delete", workspaceId, channelName),
  sessionClear: (workspaceId) => electron.ipcRenderer.invoke("session:clear", workspaceId),
  // ── Local git (Changes / Files panel) ──
  gitStatus: (dir) => electron.ipcRenderer.invoke("git:status", dir),
  gitDiff: (dir, filePath, opts) => electron.ipcRenderer.invoke("git:diff", dir, filePath, opts),
  gitFileList: (dir) => electron.ipcRenderer.invoke("git:file-list", dir),
  gitReadFile: (dir, filePath) => electron.ipcRenderer.invoke("git:read-file", dir, filePath),
  gitRepoInfo: (dir) => electron.ipcRenderer.invoke("git:repo-info", dir),
  // ── Connections ──
  listConnections: () => electron.ipcRenderer.invoke("connections:list"),
  upsertConnection: (record) => electron.ipcRenderer.invoke("connections:upsert", record),
  removeConnection: (id) => electron.ipcRenderer.invoke("connections:remove", id),
  setConnectionStatus: (id, status, lastError) => electron.ipcRenderer.invoke("connections:set-status", id, status, lastError),
  testConnection: (id) => electron.ipcRenderer.invoke("connections:test", id),
  // ── Notifications (5.4) ──
  notificationsList: () => electron.ipcRenderer.invoke("notifications:list"),
  notificationsPush: (input) => electron.ipcRenderer.invoke("notifications:push", input),
  notificationsMarkRead: (id) => electron.ipcRenderer.invoke("notifications:mark-read", id),
  notificationsMarkAllRead: () => electron.ipcRenderer.invoke("notifications:mark-all-read"),
  notificationsClear: (id) => electron.ipcRenderer.invoke("notifications:clear", id),
  notificationsGetPrefs: () => electron.ipcRenderer.invoke("notifications:get-prefs"),
  notificationsSetPrefs: (prefs) => electron.ipcRenderer.invoke("notifications:set-prefs", prefs),
  onNotificationsUpdated: (cb) => {
    const handler = (_e, list) => cb(list);
    electron.ipcRenderer.on("notifications:updated", handler);
    return () => electron.ipcRenderer.removeListener("notifications:updated", handler);
  },
  onNotificationClicked: (cb) => {
    const handler = (_e, record) => cb(record);
    electron.ipcRenderer.on("notifications:clicked", handler);
    return () => electron.ipcRenderer.removeListener("notifications:clicked", handler);
  },
  // ── GitHub Integration (4.3) ──
  githubProbe: (payload) => electron.ipcRenderer.invoke("github:probe", payload),
  githubParseRepo: (input) => electron.ipcRenderer.invoke("github:parse-repo", input),
  githubListBindings: () => electron.ipcRenderer.invoke("github:list-bindings"),
  githubBindRepo: (payload) => electron.ipcRenderer.invoke("github:bind-repo", payload),
  githubUnbindRepo: (agentName) => electron.ipcRenderer.invoke("github:unbind-repo", agentName),
  githubListIssues: (payload) => electron.ipcRenderer.invoke("github:list-issues", payload),
  githubListPullRequests: (payload) => electron.ipcRenderer.invoke("github:list-pull-requests", payload),
  githubComment: (payload) => electron.ipcRenderer.invoke("github:comment", payload),
  // ── Credentials ──
  listCredentials: () => electron.ipcRenderer.invoke("credentials:list"),
  upsertCredential: (input) => electron.ipcRenderer.invoke("credentials:upsert", input),
  removeCredential: (id) => electron.ipcRenderer.invoke("credentials:remove", id),
  revealCredential: (id) => electron.ipcRenderer.invoke("credentials:reveal", id),
  testCredential: (input) => electron.ipcRenderer.invoke("credentials:test", input),
  // ── Embedded View ──
  showEmbeddedView: (bounds, url) => electron.ipcRenderer.invoke("embedded-view:show", bounds, url),
  hideEmbeddedView: () => electron.ipcRenderer.invoke("embedded-view:hide"),
  navigateEmbeddedView: (url) => electron.ipcRenderer.invoke("embedded-view:navigate", url)
});
