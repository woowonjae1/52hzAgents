const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStorage } = require('./index');
const { migrateLegacyStore } = require('./legacy-import');

describe('Storage Layer (Package A)', () => {
  let storage;

  before(() => {
    storage = createStorage({ dbPath: ':memory:' });
  });

  after(() => {
    if (storage) {
      storage.close();
    }
  });

  describe('Database & Migrations', () => {
    it('applies initial schema migrations successfully', () => {
      const tables = storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map(r => r.name);

      assert.ok(tables.includes('sessions'), 'sessions table should exist');
      assert.ok(tables.includes('messages'), 'messages table should exist');
      assert.ok(tables.includes('events'), 'events table should exist');
      assert.ok(tables.includes('runs'), 'runs table should exist');
      assert.ok(tables.includes('tool_calls'), 'tool_calls table should exist');
      assert.ok(tables.includes('projects'), 'projects table should exist');
      assert.ok(tables.includes('checkpoints'), 'checkpoints table should exist');
      assert.ok(tables.includes('settings'), 'settings table should exist');
      assert.ok(tables.includes('messages_fts'), 'messages_fts virtual table should exist');

      const migrations = storage.db
        .prepare('SELECT version, name FROM schema_migrations')
        .all();
      assert.ok(migrations.length >= 1, 'Should have applied at least one migration');
      assert.equal(migrations[0].version, 1);
    });
  });

  describe('Sessions Repository', () => {
    it('creates, retrieves, updates, and lists sessions', () => {
      const session = storage.sessions.create({
        id: 'sess_test_1',
        title: 'Project Refactor',
        mode: 'agent',
        status: 'active',
        workingDir: 'D:/code/test',
        runtimeConfig: { model: 'deepseek-v3' },
      });

      assert.equal(session.id, 'sess_test_1');
      assert.equal(session.title, 'Project Refactor');
      assert.equal(session.mode, 'agent');
      assert.deepEqual(session.runtimeConfig, { model: 'deepseek-v3' });

      // Update
      const updated = storage.sessions.update('sess_test_1', {
        title: 'Project Refactor v2',
        mode: 'plan',
      });
      assert.equal(updated.title, 'Project Refactor v2');
      assert.equal(updated.mode, 'plan');

      // List
      const list = storage.sessions.list({ status: 'active' });
      assert.ok(list.some(s => s.id === 'sess_test_1'));
    });
  });

  describe('Messages Repository & Trigram FTS5 Full-Text Search', () => {
    it('indexes Chinese and Latin text and performs FTS5 search', () => {
      storage.messages.create({
        id: 'msg_zh_1',
        sessionId: 'sess_test_1',
        role: 'user',
        senderName: 'Alice',
        senderType: 'user',
        content: '我们需要重构桌面端运行引擎并支持真实模型',
      });

      storage.messages.create({
        id: 'msg_en_1',
        sessionId: 'sess_test_1',
        role: 'assistant',
        senderName: 'Assistant',
        senderType: 'agent',
        content: 'I have analyzed the Pi engine architecture and implemented SQLite storage.',
      });

      // Search Chinese keyword
      const zhResults = storage.search.searchMessages('运行引擎', { sessionId: 'sess_test_1' });
      assert.ok(zhResults.length > 0, 'Should find Chinese keyword match');
      assert.equal(zhResults[0].id, 'msg_zh_1');

      // Search Latin keyword
      const enResults = storage.search.searchMessages('Pi engine', { sessionId: 'sess_test_1' });
      assert.ok(enResults.length > 0, 'Should find Latin keyword match');
      assert.equal(enResults[0].id, 'msg_en_1');

      // Test trigger on update
      storage.messages.update('msg_zh_1', {
        content: '已完成数据层迁移至本地数据库引擎',
      });

      const oldSearch = storage.search.searchMessages('运行引擎', { sessionId: 'sess_test_1' });
      assert.equal(oldSearch.length, 0, 'Old content should no longer match');

      const newSearch = storage.search.searchMessages('数据库引擎', { sessionId: 'sess_test_1' });
      assert.ok(newSearch.length > 0, 'Updated content should match');

      // Test trigger on delete
      storage.messages.delete('msg_zh_1');
      const delSearch = storage.search.searchMessages('数据库引擎', { sessionId: 'sess_test_1' });
      assert.equal(delSearch.length, 0, 'Deleted message should not appear in FTS');
    });
  });

  describe('Events Repository & Cursor Pagination', () => {
    it('appends and lists events with sequence ordering and idempotency', () => {
      const e1 = storage.events.append({
        eventId: 'evt_101',
        sessionId: 'sess_test_1',
        type: 'step.started',
        source: 'pi-engine',
        target: 'session/sess_test_1',
        payload: { step: 1 },
      });

      const e2 = storage.events.append({
        eventId: 'evt_102',
        sessionId: 'sess_test_1',
        type: 'step.completed',
        source: 'pi-engine',
        target: 'session/sess_test_1',
        payload: { step: 1, duration: 120 },
      });

      assert.ok(e1.seq < e2.seq, 'Sequence numbers should be monotonically increasing');

      // Idempotent duplicate check
      const dup = storage.events.append({
        eventId: 'evt_101',
        sessionId: 'sess_test_1',
        type: 'step.started',
      });
      assert.equal(dup.seq, e1.seq, 'Duplicate eventId should return existing event');

      // List by session
      const events = storage.events.listBySession('sess_test_1', { limit: 10 });
      assert.ok(events.length >= 2);
    });
  });

  describe('Runs, Tool Calls & Approvals', () => {
    it('creates runs and manages tool call lifecycle with approvals', () => {
      const run = storage.runs.create({
        id: 'run_test_1',
        sessionId: 'sess_test_1',
        agentName: 'pi-agent',
        modelId: 'deepseek-chat',
        mode: 'agent',
      });
      assert.equal(run.status, 'queued');

      storage.runs.start('run_test_1');
      assert.equal(storage.runs.get('run_test_1').status, 'running');

      const toolCall = storage.tools.recordStart({
        id: 'tc_exec_1',
        runId: 'run_test_1',
        sessionId: 'sess_test_1',
        toolName: 'execute_command',
        args: { command: 'npm test' },
      });
      assert.equal(toolCall.status, 'running');

      storage.tools.recordApproval({
        toolCallId: 'tc_exec_1',
        sessionId: 'sess_test_1',
        decision: 'approved',
      });

      const approval = storage.tools.getApproval('tc_exec_1');
      assert.equal(approval.decision, 'approved');

      const endedTool = storage.tools.recordEnd({
        id: 'tc_exec_1',
        status: 'completed',
        output: 'Tests passed: 58',
        exitCode: 0,
      });
      assert.equal(endedTool.status, 'completed');
      assert.equal(endedTool.exitCode, 0);

      storage.runs.complete('run_test_1', { outcome: 'success' });
      assert.equal(storage.runs.get('run_test_1').status, 'completed');
    });
  });

  describe('Usage & Token Accounting', () => {
    it('records and aggregates token usage by session and model', () => {
      storage.usage.recordUsage({
        sessionId: 'sess_test_1',
        runId: 'run_test_1',
        model: 'deepseek-chat',
        promptTokens: 1000,
        completionTokens: 250,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
      });

      storage.usage.recordUsage({
        sessionId: 'sess_test_1',
        runId: 'run_test_1',
        model: 'deepseek-chat',
        promptTokens: 800,
        completionTokens: 150,
      });

      const summary = storage.usage.getSummaryForSession('sess_test_1');
      assert.equal(summary.promptTokens, 1800);
      assert.equal(summary.completionTokens, 400);
      assert.equal(summary.cacheReadTokens, 500);
      assert.equal(summary.recordCount, 2);
      assert.equal(summary.byModel.length, 1);
      assert.equal(summary.byModel[0].model, 'deepseek-chat');
    });
  });

  describe('Projects, Checkpoints & Managed Worktrees', () => {
    it('manages projects, creates multi-file checkpoints and manages worktrees', () => {
      const project = storage.projects.create({
        id: 'proj_1',
        name: 'OpenAgents Core',
        path: 'd:/code/52hzAgent/core',
        gitBranch: 'main',
      });
      assert.equal(project.id, 'proj_1');

      // Checkpoint with files inside atomic transaction
      const ckpt = storage.checkpoints.create({
        id: 'ckpt_1',
        sessionId: 'sess_test_1',
        projectId: 'proj_1',
        reason: 'Before refactoring store',
        files: [
          { filePath: 'server/store.js', beforeHash: 'aaa', afterHash: 'bbb', patchText: 'diff content' },
          { filePath: 'server/index.js', beforeHash: 'ccc', afterHash: 'ddd', patchText: null },
        ],
      });

      assert.equal(ckpt.id, 'ckpt_1');
      assert.equal(ckpt.fileCount, 2);
      assert.equal(ckpt.files.length, 2);
      assert.equal(ckpt.files[0].filePath, 'server/store.js');

      // Managed worktree
      const wt = storage.worktrees.create({
        id: 'wt_1',
        sessionId: 'sess_test_1',
        projectId: 'proj_1',
        branchName: 'feature/sqlite',
        worktreeDir: 'd:/code/52hzAgent/wt-1',
      });
      assert.equal(wt.id, 'wt_1');
      assert.equal(storage.worktrees.getByDir('d:/code/52hzAgent/wt-1').branchName, 'feature/sqlite');
    });
  });

  describe('Settings Repository', () => {
    it('stores and retrieves settings values with JSON roundtripping', () => {
      storage.settings.set('theme', 'dark');
      storage.settings.set('llm_config', { defaultModel: 'deepseek-v3', temperature: 0.7 });

      assert.equal(storage.settings.get('theme'), 'dark');
      assert.deepEqual(storage.settings.get('llm_config'), { defaultModel: 'deepseek-v3', temperature: 0.7 });
      assert.equal(storage.settings.get('non_existent', 'default_val'), 'default_val');

      const all = storage.settings.listAll();
      assert.equal(all.theme, 'dark');
    });
  });

  describe('Transaction Atomicity & Rollback', () => {
    it('rolls back database modifications when a transaction throws', () => {
      const beforeCount = storage.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;

      assert.throws(() => {
        storage.transaction(() => {
          storage.sessions.create({ id: 'sess_fail_1', title: 'Will Fail' });
          throw new Error('Simulated atomic failure');
        });
      }, /Simulated atomic failure/);

      const afterCount = storage.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
      assert.equal(afterCount, beforeCount, 'Session count should remain unchanged after rollback');
      assert.equal(storage.sessions.get('sess_fail_1'), null);
    });
  });

  describe('Legacy Store Import & Idempotency', () => {
    it('imports legacy workspace JSON and supports repeated idempotent runs', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-storage-test-'));
      const legacyFile = path.join(tempDir, 'workspace-store.json');

      const mockLegacyData = {
        workspace: {
          id: '52hz',
          name: '52hzAgents Studio Test',
          channels: [
            { name: 'general', title: 'General Channel', orchestration_mode: 'chat', status: 'active' },
            { name: 'refactor', title: 'Refactor Session', orchestration_mode: 'agent', status: 'active' },
          ],
          settings: {
            theme: 'dark',
            defaultModel: 'deepseek-v3',
          },
        },
        events: [
          {
            id: 'evt_legacy_1',
            type: 'workspace.message.posted',
            source: 'human:user',
            target: 'channel/general',
            payload: {
              content: '你好，欢迎使用 52hzAgents',
              sender_name: 'System',
              sender_type: 'system',
            },
            timestamp: 1700000000000,
          },
          {
            id: 'evt_legacy_2',
            type: 'workspace.message.posted',
            source: 'human:user',
            target: 'channel/refactor',
            payload: {
              content: 'Please analyze codebase',
              sender_name: 'Developer',
              sender_type: 'human',
            },
            timestamp: 1700000005000,
          },
        ],
      };

      fs.writeFileSync(legacyFile, JSON.stringify(mockLegacyData));

      // Separate in-memory storage for migration testing
      const testStorage = createStorage({ dbPath: ':memory:' });

      // Run migration
      const res = await migrateLegacyStore({
        storeJsonPath: legacyFile,
        storage: testStorage,
        backupDir: tempDir,
      });

      assert.equal(res.migrated, true);
      assert.equal(res.stats.importedChannels, 2);
      assert.equal(res.stats.importedEvents, 2);
      assert.equal(res.stats.importedMessages, 2);

      // Verify sessions exist
      const general = testStorage.sessions.get('general');
      assert.ok(general);
      assert.equal(general.title, 'General Channel');

      const refactor = testStorage.sessions.get('refactor');
      assert.ok(refactor);
      assert.equal(refactor.mode, 'agent');

      // Verify messages exist and are searchable via FTS5
      const msg1 = testStorage.messages.get('evt_legacy_1');
      assert.ok(msg1);
      assert.equal(msg1.content, '你好，欢迎使用 52hzAgents');

      const searchRes = testStorage.search.searchMessages('欢迎使用');
      assert.ok(searchRes.length > 0);
      assert.equal(searchRes[0].id, 'evt_legacy_1');

      // Run second time: should be skipped idempotently
      const secondRun = await migrateLegacyStore({
        storeJsonPath: legacyFile,
        storage: testStorage,
        backupDir: tempDir,
      });

      assert.equal(secondRun.migrated, false);
      assert.equal(secondRun.skipped, true);

      // Clean up temp dir
      testStorage.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Backup, Integrity & Disaster Recovery (Package B)', () => {
    it('checks database integrity and creates/rotates/restores hot backups', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-backup-test-'));
      const dbPath = path.join(tempDir, 'active.sqlite');

      // Create file-based storage for backup testing
      const fileStorage = createStorage({ dbPath });
      fileStorage.sessions.create({ id: 'sess_backup_1', title: 'Backup Session' });
      fileStorage.messages.create({
        id: 'msg_backup_1',
        sessionId: 'sess_backup_1',
        role: 'user',
        content: 'Critical conversation before backup',
      });

      // 1. Check integrity
      const integrity = fileStorage.backupManager.checkIntegrity();
      assert.equal(integrity.ok, true);
      assert.deepEqual(integrity.integrity, ['ok']);
      assert.equal(integrity.foreignKeyViolations.length, 0);

      // 2. Create online backup 1
      const b1 = await fileStorage.backupManager.createBackup({ label: 'point-1', maxRotations: 2 });
      assert.ok(fs.existsSync(b1.backupPath));
      assert.ok(fs.existsSync(`${b1.backupPath}.meta.json`));
      assert.ok(b1.checksum);

      // Modify active DB
      fileStorage.sessions.create({ id: 'sess_backup_2', title: 'Session After B1' });

      // Create online backup 2
      const b2 = await fileStorage.backupManager.createBackup({ label: 'point-2', maxRotations: 2 });

      // Create online backup 3 (should trigger rotation keeping 2)
      await new Promise(r => setTimeout(r, 10)); // Ensure distinct timestamp
      const b3 = await fileStorage.backupManager.createBackup({ label: 'point-3', maxRotations: 2 });

      const backups = fileStorage.backupManager.listBackups();
      assert.equal(backups.length, 2, 'Should only keep 2 backups after rotation');
      assert.equal(backups[0].name, path.basename(b3.backupPath));

      // 3. Disaster recovery: Restore active DB from backup 2 (which was kept)
      fileStorage.backupManager.restoreFromBackup(b2.backupPath);

      // Reopen storage on restored DB
      const restoredStorage = createStorage({ dbPath });
      assert.ok(restoredStorage.sessions.get('sess_backup_1'), 'Initial session should exist');
      assert.ok(restoredStorage.sessions.get('sess_backup_2'), 'Session created before backup 2 should exist');

      // Check corrupted file preservation
      const files = fs.readdirSync(tempDir);
      assert.ok(files.some(f => f.includes('active.sqlite.corrupt-')), 'Corrupt / prior file should be preserved');

      // Clean up
      restoredStorage.close();
      fileStorage.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
