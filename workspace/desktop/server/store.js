const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStorage } = require('./storage');
const { migrateLegacyStore } = require('./storage/legacy-import');

class Store {
  constructor(userDataPath) {
    this.userDataPath = userDataPath || process.cwd();
    this.dbFile = path.join(this.userDataPath, 'workspace-store.json');
    this.filesDir = path.join(this.userDataPath, 'files');
    
    if (!fs.existsSync(this.filesDir)) {
      try { fs.mkdirSync(this.filesDir, { recursive: true }); } catch (_) {}
    }

    this.data = this.load();
    this.committed = JSON.stringify(this.data);

    // Initialize SQLite storage layer (Package A)
    try {
      const sqlitePath = this.userDataPath === ':memory:' ? ':memory:' : path.join(this.userDataPath, 'database.sqlite');
      this.storage = createStorage({ dbPath: sqlitePath });
      migrateLegacyStore({
        storeJsonPath: this.dbFile,
        storage: this.storage,
      });

      if (this.data?.workspace?.channels) {
        for (const ch of this.data.workspace.channels) {
          const existing = this.storage.sessions.get(ch.name);
          if (!existing) {
            this.storage.sessions.create({
              id: ch.name,
              title: ch.title || ch.name,
              mode: ch.orchestration_mode || 'chat',
              status: ch.status || 'active',
              workingDir: ch.working_dir || null,
              master: ch.master_agent || null,
              runtimeConfig: ch.runtime_config || null,
              agentId: ch.agent_id || 'agent-local',
            });
          } else if (this.recovery?.recovered) {
            this.storage.sessions.update(ch.name, {
              title: ch.title,
              mode: ch.orchestration_mode,
              status: ch.status,
              working_dir: ch.working_dir,
              master: ch.master_agent,
              runtime_config: ch.runtime_config,
            });
          }
        }
      }
    } catch (err) {
      // Non-fatal warning if SQLite initialization fails in edge environments
      console.error('[Store] SQLite storage initialization warning:', err.message);
    }
  }

  load() {
    const candidates = [this.dbFile, `${this.dbFile}.bak`];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data?.workspace || !Array.isArray(data.workspace.channels) || !Array.isArray(data.events)) throw new Error('Invalid workspace data');
        const defaults = this.getDefaultData();
        if (file !== this.dbFile) this.recovery = { recovered: true, source: 'backup', timestamp: Date.now() };
        return { ...defaults, ...data };
      } catch (error) {
        // Keep corrupt bytes for recovery rather than silently replacing user data.
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}-${crypto.randomUUID()}`);
      }
    }
    if (candidates.some(file => fs.existsSync(file))) throw new Error('工作区数据及备份无法读取，已保留损坏文件。请恢复备份后重试。');
    return this.getDefaultData();
  }

  reload() {
    this.data = this.load();
    this.committed = JSON.stringify(this.data);
    if (this.storage?.sessions) {
      try {
        const sqliteSessions = this.storage.sessions.list();
        if (sqliteSessions && sqliteSessions.length > 0) {
          if (!this.data.workspace) this.data.workspace = {};
          if (!Array.isArray(this.data.workspace.channels)) this.data.workspace.channels = [];
          const channelMap = new Map(this.data.workspace.channels.map(c => [c.name, c]));
          for (const s of sqliteSessions) {
            const ch = channelMap.get(s.id);
            if (ch) {
              ch.agent_id = s.agentId;
              ch.runtime_config = s.runtimeConfig;
              ch.working_dir = s.workingDir;
              ch.status = s.status || 'active';
            } else {
              this.data.workspace.channels.push({
                name: s.id,
                title: s.title || s.id,
                agent_id: s.agentId,
                runtime_config: s.runtimeConfig,
                working_dir: s.workingDir,
                orchestration_mode: s.mode || 'chat',
                status: s.status || 'active',
              });
            }
          }
        }
      } catch (_) {}
    }
    return this.data;
  }

  save() {
    const temp = `${this.dbFile}.${crypto.randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(this.data);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      // Only a validated last version can become the backup.
      if (fs.existsSync(this.dbFile)) {
        try {
          const previous = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
          if (previous?.workspace && Array.isArray(previous.events)) {
            const backupTemp = `${temp}.bak`;
            fs.copyFileSync(this.dbFile, backupTemp);
            fs.renameSync(backupTemp, `${this.dbFile}.bak`);
          }
        } catch (error) { if (error.code) throw error; }
      }
      fs.renameSync(temp, this.dbFile);
      this.committed = serialized;
    } catch (error) {
      this.data = JSON.parse(this.committed);
      fs.rmSync(temp, { force: true });
      throw Object.assign(new Error('工作区保存失败，请检查磁盘空间与目录权限。'), { cause: error, status: 507 });
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
        members: [],
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
            content: '欢迎使用 **52hzAgents Studio**。您可以直接添加本机已配置好的 Agent（如 Pi、Codex）或使用内置助手。任务执行严格遵循文件读写与命令执行的权限审批保护。',
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
    const ws = { ...this.data.workspace };
    if (this.storage?.sessions) {
      try {
        const dbSessions = this.storage.sessions.list({ status: 'all', limit: 1000 });
        if (dbSessions && dbSessions.length > 0) {
          const map = new Map();
          for (const c of ws.channels || []) map.set(c.name, c);
          ws.channels = dbSessions.map((s) => {
            const cached = map.get(s.id) || {};
            return {
              ...cached,
              name: s.id,
              channel_name: s.id,
              title: s.title,
              status: s.status,
              master_agent: s.master,
              orchestration_mode: s.mode,
              working_dir: s.workingDir,
              runtime_config: s.runtimeConfig,
              agent_id: s.agentId,
              last_event_at: s.lastEventAt,
            };
          });
        }
      } catch (err) {
        console.error('[Store] SQLite getWorkspace failed:', err.message);
      }
    }
    return ws;
  }

  getChannel(name) {
    if (this.storage?.sessions) {
      try {
        const s = this.storage.sessions.get(name);
        if (s) {
          const inMem = this.data?.workspace?.channels?.find((c) => c.name === name) || {};
          return {
            ...inMem,
            name: s.id,
            title: s.title,
            status: s.status,
            master_agent: s.master,
            orchestration_mode: s.mode,
            working_dir: s.workingDir,
            runtime_config: s.runtimeConfig,
            agent_id: s.agentId,
            last_event_at: s.lastEventAt,
          };
        }
      } catch (err) {
        console.error('[Store] SQLite getChannel failed:', err.message);
      }
    }
    return this.data.workspace.channels.find((c) => c.name === name) || null;
  }

  updateChannel(name, updates) {
    if (updates.agent_id !== undefined) {
      if (!this.storage?.agentDefinitions) throw Object.assign(new Error('Agent storage unavailable.'), { status: 503 });
      this.storage.agentDefinitions.requireActive(updates.agent_id);
    }
    let ch = this.data.workspace.channels.find((c) => c.name === name);
    if (!ch) {
      ch = { name, title: name, status: 'active', ...updates };
      this.data.workspace.channels.push(ch);
    } else {
      Object.assign(ch, updates);
    }
    this.save();

    if (this.storage) {
      try {
        const existing = this.storage.sessions.get(name);
        if (!existing) {
          this.storage.sessions.create({
            id: name,
            title: ch.title || name,
            mode: ch.orchestration_mode || 'chat',
            status: ch.status || 'active',
            workingDir: ch.working_dir || null,
            master: ch.master_agent || null,
            runtimeConfig: ch.runtime_config || null,
            agentId: ch.agent_id || 'agent-local',
          });
        } else {
          this.storage.sessions.update(name, {
            title: ch.title,
            mode: ch.orchestration_mode,
            status: ch.status,
            working_dir: ch.working_dir,
            master: ch.master_agent,
            runtime_config: ch.runtime_config,
            agent_id: updates.agent_id,
          });
        }
      } catch (err) {
        console.error('[Store] SQLite updateChannel failed:', err);
        throw err;
      }
    }

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
    const channel = this.getChannel(normalized.target.replace(/^channel\//, ''));
    if (channel && normalized.type === 'workspace.message.posted') channel.last_event_at = normalized.timestamp;
    // Keep max 5000 recent events in memory cache
    if (this.data.events.length > 5000) {
      this.data.events.splice(0, this.data.events.length - 5000);
    }
    this.save();

    if (this.storage) {
      try {
        const appended = this.syncEventToStorage(normalized);
        if (appended && appended.seq) {
          normalized.seq = appended.seq;
        }
      } catch (err) {
        console.error('[Store] SQLite addEvent sync failed:', err);
        throw err;
      }
    }

    return normalized;
  }

  syncEventToStorage(event) {
    if (!this.storage) return null;
    let sessionId = null;
    const target = event.target || 'channel/general';
    if (typeof target === 'string' && target.startsWith('channel/')) {
      sessionId = target.slice('channel/'.length);
    } else if (typeof target === 'string') {
      sessionId = target;
    }

    const appended = this.storage.events.append({
      eventId: event.id || event.event_id,
      sessionId,
      type: event.type,
      source: event.source,
      target: event.target,
      payload: event.payload,
      metadata: event.metadata,
      timestamp: event.timestamp,
    });

    if (event.type === 'workspace.message.posted' && sessionId) {
      const payload = event.payload || {};
      const content = typeof payload.content === 'string' ? payload.content : (payload.text || '');
      const senderType = payload.sender_type || 'user';
      const senderName = payload.sender_name || (senderType === 'human' ? 'User' : 'Agent');

      let role = 'user';
      if (senderType === 'agent' || senderType === 'bot' || senderType === 'assistant') {
        role = 'assistant';
      } else if (senderType === 'system') {
        role = 'system';
      } else if (senderType === 'tool') {
        role = 'tool';
      }

      this.storage.messages.append({
        id: event.id || event.event_id,
        sessionId,
        role,
        senderName,
        senderType,
        content,
        metadata: event.metadata,
        timestamp: event.timestamp,
      });
    }

    return appended;
  }

  getEvents(opts = {}) {
    if (this.storage?.events) {
      try {
        let sessionId = undefined;
        let target = opts.target;
        if (opts.channel) {
          target = opts.channel.startsWith('channel/') ? opts.channel : `channel/${opts.channel}`;
          sessionId = opts.channel.replace(/^channel\//, '');
        }
        let list = this.storage.events.list({
          sessionId,
          target,
          type: opts.type,
          after: opts.after,
          before: opts.before,
          afterSeq: opts.afterSeq,
          limit: opts.limit ? parseInt(opts.limit, 10) : 100,
        });
        if (opts.search) {
          const q = opts.search.toLowerCase();
          list = list.filter((e) => JSON.stringify(e.payload || {}).toLowerCase().includes(q));
        }
        if (opts.sort === 'desc') {
          list.reverse();
        }
        return list;
      } catch (err) {
        console.error('[Store] SQLite getEvents failed, falling back to cache:', err.message);
      }
    }

    let result = [...this.data.events];
    if (opts.channel) {
      const target = opts.channel.startsWith('channel/') ? opts.channel : `channel/${opts.channel}`;
      result = result.filter((e) => e.target === target || e.target === opts.channel);
    }
    if (opts.type) {
      result = result.filter((e) => e.type.startsWith(opts.type));
    }
    if (opts.target) result = result.filter(e => e.target === opts.target);
    if (opts.after) {
      const cursor = this.data.events.find(e => e.id === opts.after);
      if (cursor) { const later = new Set(this.data.events.slice(this.data.events.indexOf(cursor) + 1)); result = result.filter(e => later.has(e)); }
      else if (Number.isFinite(Number(opts.after))) result = result.filter(e => e.timestamp > Number(opts.after));
    }
    if (opts.before) {
      const cursor = this.data.events.find(e => e.id === opts.before);
      if (cursor) { const earlier = new Set(this.data.events.slice(0, this.data.events.indexOf(cursor))); result = result.filter(e => earlier.has(e)); }
      else if (Number.isFinite(Number(opts.before))) result = result.filter(e => e.timestamp < Number(opts.before));
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
    if (this.storage?.events) {
      try {
        const events = this.storage.events.getLatestPerChannel();
        const map = {};
        for (const e of events) {
          if (e.target && e.target.startsWith('channel/')) {
            const ch = e.target.replace(/^channel\//, '');
            map[ch] = e;
          }
        }
        return map;
      } catch (err) {
        console.error('[Store] SQLite getLatestPerChannel failed, falling back to cache:', err.message);
      }
    }

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
    if (this.storage?.timers) {
      return this.storage.timers.list();
    }
    return this.data.timers;
  }

  addTimer(timer) {
    if (this.storage?.timers) {
      const added = this.storage.timers.create(timer);
      this.data.timers = this.data.timers.filter((t) => t.id !== added.id).concat(added);
      this.save();
      return added;
    }
    const id = timer.id || `timer-${Date.now()}`;
    const t = { ...timer, id };
    this.data.timers.push(t);
    this.save();
    return t;
  }

  deleteTimer(id) {
    if (this.storage?.timers) {
      this.storage.timers.delete(id);
    }
    this.data.timers = this.data.timers.filter((t) => t.id !== id);
    this.save();
    return true;
  }

  getRoutines() {
    if (this.storage?.routines) {
      return this.storage.routines.list();
    }
    return this.data.routines;
  }

  addRoutine(routine) {
    if (this.storage?.routines) {
      const added = this.storage.routines.create(routine);
      this.data.routines = this.data.routines.filter((r) => r.id !== added.id).concat(added);
      this.save();
      return added;
    }
    const id = routine.id || `routine-${Date.now()}`;
    const r = { ...routine, id };
    this.data.routines.push(r);
    this.save();
    return r;
  }

  deleteRoutine(id) {
    if (this.storage?.routines) {
      this.storage.routines.delete(id);
    }
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
    const id = approval?.id || `appr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const a = {
      ...approval,
      id,
      status: 'pending',
      decision: 'pending',
      used: false,
      created_at: new Date().toISOString(),
    };
    this.data.approvals.push(a);
    this.save();
    return a;
  }

  updateApproval(id, status) {
    const a = this.data.approvals.find((x) => x.id === id);
    if (a) {
      if (a.used && (status === 'approved' || status === 'granted')) {
        throw new Error('Cannot approve an already used approval');
      }
      a.status = status;
      a.decision = status;
      a.resolved_at = new Date().toISOString();
      this.save();
    }
    return a;
  }

  searchMessages(query, opts = {}) {
    if (!this.storage) return [];
    try {
      return this.storage.search.searchMessages(query, opts);
    } catch (_) {
      return [];
    }
  }

  close() {
    if (this.storage) {
      try { this.storage.close(); } catch (_) {}
    }
  }
}

module.exports = { Store };
