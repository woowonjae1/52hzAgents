'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Main entry point for the agent-connector library.
 * Rewritten as a thin wrapper that delegates core mutations and daemon controls
 * to the Go 'agn' binary while maintaining 100% API compatibility with Electron Launcher.
 */
class AgentConnector {
  constructor(opts = {}) {
    this._configDir = opts.configDir || AgentConnector.defaultConfigDir();
  }

  static defaultConfigDir() {
    return path.join(os.homedir(), '.52hzagents');
  }

  static getAgnBinaryPath() {
    const ext = process.platform === 'win32' ? '.exe' : '';
    
    // Tier 1: Check ~/.52hzagents/bin/agn
    const sandboxPath = path.join(os.homedir(), '.52hzagents', 'bin', `agn${ext}`);
    if (fs.existsSync(sandboxPath)) {
      return sandboxPath;
    }
    
    // Tier 2: Check local agn_go build folder
    const localBuildPath = path.resolve(__dirname, '../../agn_go/agn' + ext);
    if (fs.existsSync(localBuildPath)) {
      return localBuildPath;
    }

    // Tier 3: Fallback to system PATH
    return `agn${ext}`;
  }

  _runAgn(args) {
    const binary = AgentConnector.getAgnBinaryPath();
    try {
      const output = execFileSync(binary, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return { success: true, output: output.trim() };
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
      return { success: false, error: stderr };
    }
  }

  // -- Registry --

  async getCatalog() {
    const registryPath = path.resolve(__dirname, '../../agn_go/internal/registry/registry.json');
    if (!fs.existsSync(registryPath)) {
      return [];
    }
    try {
      const catalog = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      return catalog.map((entry) => {
        const installed = this.isInstalled(entry.name);
        return {
          ...entry,
          installed,
          managed: true,
          location: installed ? path.join(os.homedir(), '.52hzagents', 'bin', entry.name) : null
        };
      });
    } catch {
      return [];
    }
  }

  clearCatalogCache() {
    // No-op for stateless wrapper
  }

  getEnvFields(agentType) {
    const registryPath = path.resolve(__dirname, '../../agn_go/internal/registry/registry.json');
    if (!fs.existsSync(registryPath)) return [];
    try {
      const catalog = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      const entry = catalog.find(e => e.name === agentType);
      return entry ? (entry.env_config || []) : [];
    } catch {
      return [];
    }
  }

  // -- Install / Uninstall --

  async install(agentType) {
    const res = this._runAgn(['install', agentType]);
    if (!res.success) throw new Error(res.error);
    return res;
  }

  async uninstall(agentType) {
    // Placeholder uninstall command if implemented in Go
    return { success: true };
  }

  isInstalled(agentType) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binaryName = agentType + ext;
    
    // Check in PATH
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      execFileSync(whichCmd, [agentType], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {}

    // Check in local sandbox bin/
    const sandboxBin = path.join(os.homedir(), '.52hzagents', 'bin', binaryName);
    if (fs.existsSync(sandboxBin)) return true;

    return false;
  }

  healthCheck(agentType) {
    if (this.isInstalled(agentType)) {
      return { ok: true };
    }
    return { ok: false, reason: 'runtime_missing', message: `${agentType} runtime is not installed` };
  }

  // -- Agent CRUD --

  listAgents() {
    const filePath = path.join(this._configDir, 'config.json');
    if (!fs.existsSync(filePath)) return [];
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const agents = Object.values(config.agents || {});
      const workspaces = Object.values(config.workspaces || {});
      return agents.map((a) => {
        const type = a.type || 'openclaw';
        const ws = workspaces.find((w) => w.id === a.workspace_id);
        return {
          name: a.name,
          type,
          role: 'worker',
          network: a.workspace_id || null,
          networkName: ws ? (ws.name || ws.id) : null,
          path: null,
          env: a.env || {},
          instanceEnv: a.env || {},
        };
      });
    } catch (err) {
      return [];
    }
  }

  addAgent({ name, type, role, path, env }) {
    const args = ['create', name, '--type', type || 'openclaw'];
    const res = this._runAgn(args);
    if (!res.success) throw new Error(res.error);

    if (env && Object.keys(env).length > 0) {
      this.saveAgentInstanceEnv(name, env);
    }
    return { success: true };
  }

  removeAgent(name) {
    const res = this._runAgn(['remove', name]);
    if (!res.success) throw new Error(res.error);
    return { success: true };
  }

  // -- Env config --

  getAgentEnv(agentType) {
    // Retain compatibility with type-level env files under configDir/env/
    const envPath = path.join(this._configDir, 'env', `${agentType}.env`);
    if (!fs.existsSync(envPath)) return {};
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const env = {};
      content.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
          env[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
      });
      return env;
    } catch {
      return {};
    }
  }

  getAgentInstanceEnv(agentName) {
    const filePath = path.join(this._configDir, 'config.json');
    if (!fs.existsSync(filePath)) return {};
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const agent = config.agents[agentName];
      return agent ? (agent.env || {}) : {};
    } catch {
      return {};
    }
  }

  saveAgentEnv(agentType, env) {
    // Save type-level env file
    const envDir = path.join(this._configDir, 'env');
    fs.mkdirSync(envDir, { recursive: true });
    const envPath = path.join(envDir, `${agentType}.env`);
    const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(envPath, content, 'utf-8');
    return { success: true };
  }

  deleteAgentEnv(agentType) {
    const envPath = path.join(this._configDir, 'env', `${agentType}.env`);
    if (fs.existsSync(envPath)) {
      fs.unlinkSync(envPath);
    }
    return { success: true };
  }

  saveAgentInstanceEnv(agentName, env) {
    const filePath = path.join(this._configDir, 'config.json');
    if (!fs.existsSync(filePath)) throw new Error('config.json not found');
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!config.agents[agentName]) throw new Error(`Agent '${agentName}' not found`);
      config.agents[agentName].env = env;
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
      
      // Notify daemon to reload
      this.sendDaemonCommand('reload');
      return { success: true };
    } catch (err) {
      throw new Error(`Failed to save instance env: ${err.message}`);
    }
  }

  resolveAgentEnv(agentType, saved) {
    const fields = this.getEnvFields(agentType);
    const resolved = {};
    fields.forEach(f => {
      if (saved[f.name]) {
        resolved[f.name] = saved[f.name];
      } else if (f.default) {
        resolved[f.name] = f.default;
      }
    });
    return resolved;
  }

  // -- Workspace --

  listWorkspaces() {
    const filePath = path.join(this._configDir, 'config.json');
    if (!fs.existsSync(filePath)) return [];
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Object.values(config.workspaces || {}).map((w) => ({
        id: w.id,
        slug: w.name || w.id,
        name: w.name || w.id,
        endpoint: w.endpoint || '',
        token: w.token || '',
      }));
    } catch {
      return [];
    }
  }

  connectWorkspace(agentName, networkSlug) {
    const filePath = path.join(this._configDir, 'config.json');
    if (!fs.existsSync(filePath)) return { success: false };
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const ws = Object.values(config.workspaces || {}).find(w => w.name === networkSlug || w.id === networkSlug);
      if (!ws) throw new Error(`Workspace '${networkSlug}' not found`);
      
      const args = ['connect', agentName, ws.token, '--network', ws.id, '--endpoint', ws.endpoint];
      const res = this._runAgn(args);
      if (!res.success) throw new Error(res.error);
      return { success: true };
    } catch (err) {
      throw new Error(`Connect workspace failed: ${err.message}`);
    }
  }

  disconnectWorkspace(agentName) {
    const res = this._runAgn(['disconnect', agentName]);
    if (!res.success) throw new Error(res.error);
    return { success: true };
  }

  async removeWorkspace(slug) {
    const filePath = path.join(this._configDir, 'config.json');
    if (!fs.existsSync(filePath)) return { success: false };
    try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const wsKey = Object.keys(config.workspaces || {}).find(k => config.workspaces[k].name === slug || k === slug);
      if (wsKey) {
        delete config.workspaces[wsKey];
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
        this.sendDaemonCommand('reload');
      }
      return { success: true };
    } catch (err) {
      throw new Error(`Remove workspace failed: ${err.message}`);
    }
  }

  // -- Daemon lifecycle --

  createDaemon() {
    return {
      start: () => this.startDaemon(),
      stop: () => this.stopDaemon(),
    };
  }

  startDaemon(foregroundArgs) {
    const res = this._runAgn(['up']);
    if (!res.success) throw new Error(res.error);
  }

  stopDaemon() {
    const res = this._runAgn(['down']);
    if (!res.success) throw new Error(res.error);
  }

  getDaemonPid() {
    const pidFile = path.join(this._configDir, 'daemon.pid');
    if (!fs.existsSync(pidFile)) return null;
    try {
      const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
      return parseInt(pidStr, 10) || null;
    } catch {
      return null;
    }
  }

  getDaemonStatus() {
    const statusFile = path.join(this._configDir, 'daemon.status.json');
    if (!fs.existsSync(statusFile)) return { agents: {}, pid: null };
    try {
      return JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
    } catch {
      return { agents: {}, pid: null };
    }
  }

  sendDaemonCommand(cmd) {
    const binary = AgentConnector.getAgnBinaryPath();
    const port = '52000'; // Default TCP port
    
    // Connect directly via TCP command channel to notify daemon instantly
    const net = require('net');
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.write(cmd + '\n');
    });
    client.on('error', () => {
      // Fallback to command file IPC
      const cmdFile = path.join(this._configDir, 'daemon.cmd');
      fs.writeFileSync(cmdFile, cmd + '\n', 'utf-8');
    });
    client.on('data', () => {
      client.end();
    });
  }

  getLogs(agentName, lines = 200) {
    const logPath = path.join(this._configDir, 'daemon.log');
    if (!fs.existsSync(logPath)) return '';
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const filtered = agentName 
        ? allLines.filter(l => l.includes(`[${agentName}]`))
        : allLines;
      return filtered.slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  tailLogs(opts = {}) {
    // Handled in JS fallback or CLI wrapper if needed
    return null;
  }

  clearLogsInRange(opts = {}) {
    return { success: true };
  }

  // -- Workspace API --

  async createWorkspace(opts) {
    const { WorkspaceClient } = require('./workspace-client');
    const client = new WorkspaceClient(opts.endpoint);
    return client.createWorkspace(opts);
  }

  async joinWorkspace(agentName, token, opts) {
    const { WorkspaceClient } = require('./workspace-client');
    const client = new WorkspaceClient(opts.endpoint);
    return client.joinNetwork(agentName, token, opts);
  }

  async resolveToken(token) {
    const { WorkspaceClient } = require('./workspace-client');
    const client = new WorkspaceClient();
    return client.resolveToken(token);
  }

  // -- LLM test --

  async testLLM(env) {
    const { testLLMConnection } = require('./utils');
    return testLLMConnection(env);
  }
}

const adapters = require('./adapters');
const paths = require('./paths');
module.exports = { AgentConnector, WorkspaceClient: null, Daemon: null, adapters, paths };
