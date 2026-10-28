const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(userDataPath) {
    this.userDataPath = userDataPath || process.cwd();
    this.dbFile = path.join(this.userDataPath, 'workspace-store.json');
    this.filesDir = path.join(this.userDataPath, 'files');
    
    if (!fs.existsSync(this.filesDir)) {
      try { fs.mkdirSync(this.filesDir, { recursive: true }); } catch (_) {}
    }

    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const raw = fs.readFileSync(this.dbFile, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[Store] Failed to load store file, initializing default:', e.message);
    }

    return this.getDefaultData();
  }

  save() {
    try {
      fs.writeFileSync(this.dbFile, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[Store] Save failed:', e.message);
    }
  }

  getDefaultData() {
    return {
      workspace: {
        id: '52hz',
        slug: '52hz',
        name: '52hzAgents Studio',
        owner: 'human:user',
        created_at: new Date().toISOString(),
        channels: [
          {
            name: 'general',
            title: 'General',
            status: 'active',
            starred: true,
            master_agent: 'deepseek',
            orchestration_mode: 'dynamic',
            working_dir: process.cwd(),
          },
        ],
        members: [
          { name: 'deepseek', role: 'master', status: 'online', description: 'DeepSeek Reasoner & Coder (V3 / R1)' },
          { name: 'claude', role: 'collaborator', status: 'online', description: 'Anthropic Claude 3.7 Sonnet' },
          { name: 'gemini', role: 'collaborator', status: 'online', description: 'Google Gemini 2.5 Flash / Pro' },
          { name: 'ollama', role: 'collaborator', status: 'online', description: 'Local Ollama Instance' },
        ],
        settings: {
          theme: 'dark',
          defaultModel: 'deepseek-v3',
        },
      },
      events: [
        {
          id: 'evt-init',
          event_id: 'evt-init',
          network: '52hz',
          type: 'workspace.message.posted',
          source: 'openagents:system',
          target: 'channel/general',
          payload: {
            content: '👋 **欢迎使用 52hzAgents Studio**\n\n本地工作台已无缝启动。支持多模型编排 (DeepSeek, Claude, Gemini, Ollama) 与本地 Git、文件管理。',
            sender_name: 'System',
            sender_type: 'agent',
          },
          metadata: {},
          timestamp: Date.now(),
        },
      ],
      files: [],
      todos: [],
      timers: [],
      routines: [],
      notifications: [],
      approvals: [],
    };
  }

  getWorkspace() {
    return this.data.workspace;
  }

  getChannel(name) {
    return this.data.workspace.channels.find((c) => c.name === name) || null;
  }

  updateChannel(name, updates) {
    let ch = this.getChannel(name);
    if (!ch) {
      ch = { name, title: name, status: 'active', ...updates };
      this.data.workspace.channels.push(ch);
    } else {
      Object.assign(ch, updates);
    }
    this.save();
    return ch;
  }

  addEvent(event) {
    const id = event.id || event.event_id || `evt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const normalized = {
      id,
      event_id: id,
      network: event.network || '52hz',
      type: event.type || 'workspace.message.posted',
      source: event.source || 'human:user',
      target: event.target || 'channel/general',
      payload: event.payload || {},
      metadata: event.metadata || {},
      timestamp: event.timestamp || Date.now(),
      client_message_id: event.client_message_id,
    };

    if (event.client_message_id) {
      const existing = this.data.events.find(
        (e) => e.client_message_id && e.client_message_id === event.client_message_id
      );
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }

    this.data.events.push(normalized);
    // Keep max 5000 recent events
    if (this.data.events.length > 5000) {
      this.data.events.splice(0, this.data.events.length - 5000);
    }
    this.save();
    return normalized;
  }

  getEvents(opts = {}) {
    let result = [...this.data.events];
    if (opts.channel) {
      const target = opts.channel.startsWith('channel/') ? opts.channel : `channel/${opts.channel}`;
      result = result.filter((e) => e.target === target || e.target === opts.channel);
    }
    if (opts.type) {
      result = result.filter((e) => e.type.startsWith(opts.type));
    }
    if (opts.after) {
      result = result.filter((e) => e.id > opts.after || String(e.timestamp) > opts.after);
    }
    if (opts.before) {
      result = result.filter((e) => e.id < opts.before || String(e.timestamp) < opts.before);
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      result = result.filter((e) => JSON.stringify(e.payload).toLowerCase().includes(q));
    }
    if (opts.sort === 'desc') {
      result.reverse();
    }
    const limit = opts.limit ? parseInt(opts.limit, 10) : 100;
    return result.slice(0, limit);
  }

  getLatestPerChannel() {
    const map = {};
    for (const ch of this.data.workspace.channels) {
      const target = `channel/${ch.name}`;
      const events = this.data.events.filter((e) => e.target === target);
      if (events.length > 0) {
        map[ch.name] = events[events.length - 1];
      }
    }
    return map;
  }

  addFile(fileMeta) {
    this.data.files.push(fileMeta);
    this.save();
    return fileMeta;
  }

  getFiles() {
    return this.data.files;
  }

  getFile(id) {
    return this.data.files.find((f) => f.id === id) || null;
  }

  getTodos() {
    return this.data.todos;
  }

  putTodos(todos) {
    this.data.todos = Array.isArray(todos) ? todos : [];
    this.save();
    return this.data.todos;
  }

  getTimers() {
    return this.data.timers;
  }

  addTimer(timer) {
    const id = timer.id || `timer-${Date.now()}`;
    const t = { ...timer, id };
    this.data.timers.push(t);
    this.save();
    return t;
  }

  deleteTimer(id) {
    this.data.timers = this.data.timers.filter((t) => t.id !== id);
    this.save();
    return true;
  }

  getRoutines() {
    return this.data.routines;
  }

  addRoutine(routine) {
    const id = routine.id || `routine-${Date.now()}`;
    const r = { ...routine, id };
    this.data.routines.push(r);
    this.save();
    return r;
  }

  deleteRoutine(id) {
    this.data.routines = this.data.routines.filter((r) => r.id !== id);
    this.save();
    return true;
  }

  getNotifications(opts = {}) {
    let list = this.data.notifications.filter((n) => n.status !== 'dismissed');
    if (opts.status) list = list.filter((n) => n.status === opts.status);
    if (opts.is_read !== undefined) {
      const isRead = opts.is_read === 'true' || opts.is_read === true;
      list = list.filter((n) => Boolean(n.is_read) === isRead);
    }
    return list;
  }

  addNotification(notif) {
    const id = notif.id || `notif-${Date.now()}`;
    const n = {
      id,
      ...notif,
      created_at: new Date().toISOString(),
      is_read: false,
      status: 'active',
    };
    this.data.notifications.push(n);
    this.save();
    return n;
  }

  markNotificationRead(id) {
    const n = this.data.notifications.find((x) => x.id === id);
    if (n) {
      n.is_read = true;
      this.save();
    }
    return n;
  }

  getApprovals(opts = {}) {
    let list = [...this.data.approvals];
    if (opts.status) list = list.filter((a) => a.status === opts.status);
    return list;
  }

  addApproval(approval) {
    const id = approval.id || `appr-${Date.now()}`;
    const a = { ...approval, id, status: 'pending', created_at: new Date().toISOString() };
    this.data.approvals.push(a);
    this.save();
    return a;
  }

  updateApproval(id, status) {
    const a = this.data.approvals.find((x) => x.id === id);
    if (a) {
      a.status = status;
      a.resolved_at = new Date().toISOString();
      this.save();
    }
    return a;
  }
}

module.exports = { Store };
