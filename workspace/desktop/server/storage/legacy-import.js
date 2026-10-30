const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Migrate legacy workspace-store.json data to SQLite storage idempotently.
 *
 * @param {Object} options
 * @param {string} options.storeJsonPath - Path to workspace-store.json
 * @param {import('./index').Storage} options.storage - Initialized Storage instance
 * @param {string} [options.backupDir] - Optional directory to save pre-migration backup
 * @returns {{ migrated: boolean, skipped?: boolean, reason?: string, stats?: Object }}
 */
function migrateLegacyStore({ storeJsonPath, storage, backupDir }) {
  if (!storeJsonPath || !storage) {
    throw new Error('storeJsonPath and storage are required for legacy store migration');
  }

  // 1. Check if already migrated
  const migrationMarker = storage.settings.get('legacy_store_migrated');
  if (migrationMarker && migrationMarker.migratedAt) {
    return {
      migrated: false,
      skipped: true,
      reason: 'Legacy store already migrated at ' + migrationMarker.migratedAt,
      marker: migrationMarker,
    };
  }

  // 2. Locate source file (primary or .bak), test-parsing JSON to handle corruption
  const candidates = [storeJsonPath, `${storeJsonPath}.bak`];
  let activeFile = null;
  let rawData = null;

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.workspace) {
        activeFile = file;
        rawData = parsed;
        break;
      }
    } catch (_) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}-${crypto.randomUUID()}`);
      } catch (copyErr) {}
    }
  }

  if (!activeFile || !rawData) {
    if (candidates.some(file => fs.existsSync(file))) {
      throw new Error('工作区数据及备份无法读取，已保留损坏文件。请恢复备份后重试。');
    }
    // No legacy JSON file exists (fresh install)
    storage.settings.set('legacy_store_migrated', {
      migratedAt: new Date().toISOString(),
      channelsCount: 0,
      eventsCount: 0,
      messagesCount: 0,
      freshInstall: true,
    });
    return {
      migrated: false,
      skipped: true,
      reason: 'No legacy JSON file found, marked as fresh install',
    };
  }

  // 3. Create pre-migration backup
  const backupFolder = backupDir || path.dirname(activeFile);
  fs.mkdirSync(backupFolder, { recursive: true });
  const backupName = `${path.basename(activeFile)}.pre-sqlite-migration.${Date.now()}`;
  const backupPath = path.join(backupFolder, backupName);
  try {
    fs.copyFileSync(activeFile, backupPath);
  } catch (err) {
    throw new Error(`Failed to create pre-migration backup at ${backupPath}: ${err.message}`);
  }

  // 4. Execute migration inside an atomic transaction
  const channels = rawData.workspace?.channels || [];
  const events = rawData.events || [];
  const legacySettings = rawData.workspace?.settings || {};
  let importedChannels = 0;
  let importedEvents = 0;
  let importedMessages = 0;

  storage.transaction(db => {
    // Import settings
    for (const [key, value] of Object.entries(legacySettings)) {
      storage.settings.set(`workspace_${key}`, value);
    }
    if (rawData.workspace?.name) {
      storage.settings.set('workspace_name', rawData.workspace.name);
    }

    // Import channels as sessions
    const sessionMap = new Set();
    const sessionInsert = db.prepare(`
      INSERT INTO sessions (
        id, title, mode, status, working_dir, master, runtime_config_json, last_event_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        mode = excluded.mode,
        status = excluded.status,
        working_dir = COALESCE(excluded.working_dir, sessions.working_dir),
        master = COALESCE(excluded.master, sessions.master),
        runtime_config_json = COALESCE(excluded.runtime_config_json, sessions.runtime_config_json),
        last_event_at = COALESCE(excluded.last_event_at, sessions.last_event_at),
        updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();
    for (const ch of channels) {
      const sessionId = ch.name || 'general';
      sessionMap.add(sessionId);

      const title = ch.title || ch.name;
      const mode = ch.orchestration_mode || 'chat';
      const status = ch.status || 'active';
      const workingDir = ch.working_dir || null;
      const master = ch.master_agent || null;
      const runtimeConfigJson = ch.runtime_config ? JSON.stringify(ch.runtime_config) : null;
      const lastEventAt = ch.last_event_at || null;

      sessionInsert.run(
        sessionId,
        title,
        mode,
        status,
        workingDir,
        master,
        runtimeConfigJson,
        lastEventAt,
        now,
        now
      );
      importedChannels++;
    }

    // Always ensure general session exists
    if (!sessionMap.has('general')) {
      sessionInsert.run('general', 'General', 'chat', 'active', null, null, null, null, now, now);
      sessionMap.add('general');
    }

    // Import events & messages
    const eventInsert = db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, session_id, type, source, target, payload_json, metadata_json, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const messageInsert = db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, session_id, role, sender_name, sender_type, content, metadata_json, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const evt of events) {
      const eventId = evt.id || evt.event_id || `evt_${crypto.randomUUID()}`;
      const target = evt.target || 'channel/general';
      let sessionId = null;

      if (target.startsWith('channel/')) {
        sessionId = target.slice('channel/'.length);
      } else if (sessionMap.has(target)) {
        sessionId = target;
      }

      // If event targets a session that wasn't in channels, create it
      if (sessionId && !sessionMap.has(sessionId)) {
        sessionInsert.run(sessionId, sessionId, 'chat', 'active', null, null, null, null, now, now);
        sessionMap.add(sessionId);
      }

      const timestamp = evt.timestamp || Date.now();
      const createdAt = new Date(timestamp).toISOString();
      const payloadJson = evt.payload ? JSON.stringify(evt.payload) : '{}';
      const metadataJson = evt.metadata ? JSON.stringify(evt.metadata) : null;

      const eventRes = eventInsert.run(
        eventId,
        sessionId,
        evt.type || 'workspace.message.posted',
        evt.source || 'user',
        target,
        payloadJson,
        metadataJson,
        timestamp,
        createdAt
      );

      if (eventRes.changes > 0) {
        importedEvents++;
      }

      // If message posted event, also populate relational messages table
      if (evt.type === 'workspace.message.posted' && sessionId) {
        const payload = evt.payload || {};
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

        const msgRes = messageInsert.run(
          eventId,
          sessionId,
          role,
          senderName,
          senderType,
          content,
          metadataJson,
          timestamp,
          createdAt
        );

        if (msgRes.changes > 0) {
          importedMessages++;
        }
      }
    }

    // Import legacy timers
    const legacyTimers = rawData.timers || [];
    for (const t of legacyTimers) {
      try {
        storage.timers.create(t);
      } catch (_) {}
    }

    // Import legacy routines
    const legacyRoutines = rawData.routines || [];
    for (const r of legacyRoutines) {
      try {
        storage.routines.create(r);
      } catch (_) {}
    }

    // Save migration marker
    storage.settings.set('legacy_store_migrated', {
      migratedAt: now,
      sourceFile: activeFile,
      backupFile: backupPath,
      channelsCount: importedChannels,
      eventsCount: importedEvents,
      messagesCount: importedMessages,
    });
  });

  return {
    migrated: true,
    stats: {
      sourceFile: activeFile,
      backupPath,
      importedChannels,
      importedEvents,
      importedMessages,
    },
  };
}

module.exports = { migrateLegacyStore };
