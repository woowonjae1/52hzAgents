const path = require('path');
const { DatabaseManager, closeDatabasesUnder } = require('./database');
const { SessionsRepository } = require('./repositories/sessions');
const { MessagesRepository } = require('./repositories/messages');
const { EventsRepository } = require('./repositories/events');
const { RunsRepository } = require('./repositories/runs');
const { ToolsRepository } = require('./repositories/tools');
const { UsageRepository } = require('./repositories/usage');
const { ProjectsRepository } = require('./repositories/projects');
const { CheckpointsRepository } = require('./repositories/checkpoints');
const { WorktreesRepository } = require('./repositories/worktrees');
const { SettingsRepository } = require('./repositories/settings');
const { SearchRepository } = require('./repositories/search');
const { TranscriptsRepository } = require('./repositories/transcripts');
const { OutboxRepository } = require('./repositories/outbox');
const { PricingRepository } = require('./repositories/pricing');
const { BudgetsRepository } = require('./repositories/budgets');
const { CapabilitiesRepository } = require('./repositories/capabilities');
const { KnowledgeRepository } = require('./repositories/knowledge');
const { McpRepository } = require('./repositories/mcp');
const { ArtifactsRepository } = require('./repositories/artifacts');
const { AttachmentsRepository } = require('./repositories/attachments');
const { RoutinesRepository } = require('./repositories/routines');
const { TimersRepository } = require('./repositories/timers');
const { PipelinesRepository } = require('./repositories/pipelines');
const { OrchestrationRepository } = require('./repositories/orchestration');
const { BackupManager } = require('./backup');
const { AgentDefinitionsRepository } = require('./repositories/agent-definitions');

class Storage {
  /**
   * @param {DatabaseManager} manager
   * @param {Object} [options]
   */
  constructor(manager, options = {}) {
    this.options = options;
    this.reconnect(manager.dbPath, manager);
  }

  reconnect(dbPath, existingManager = null) {
    if (existingManager) {
      this.manager = existingManager;
    } else {
      const { DatabaseManager } = require('./database');
      this.manager = new DatabaseManager(dbPath, {
        migrationsDir: this.options.migrationsDir || path.join(__dirname, 'migrations'),
        ...this.options,
      });
    }
    this.db = this.manager.db;

    this.sessions = new SessionsRepository(this.manager);
    this.agentDefinitions = new AgentDefinitionsRepository(this.manager);
    this.messages = new MessagesRepository(this.manager);
    this.events = new EventsRepository(this.manager);
    this.runs = new RunsRepository(this.manager);
    this.tools = new ToolsRepository(this.manager);
    this.usage = new UsageRepository(this.manager);
    this.projects = new ProjectsRepository(this.manager);
    this.checkpoints = new CheckpointsRepository(this.manager);
    this.worktrees = new WorktreesRepository(this.manager);
    this.settings = new SettingsRepository(this.manager);
    this.search = new SearchRepository(this.manager);
    this.transcripts = new TranscriptsRepository(this.manager);
    this.outbox = new OutboxRepository(this.manager);
    this.pricing = new PricingRepository(this.manager);
    this.budgets = new BudgetsRepository(this.manager);
    this.capabilities = new CapabilitiesRepository(this.manager);
    this.knowledge = new KnowledgeRepository(this.manager);
    this.mcp = new McpRepository(this.manager);
    this.artifacts = new ArtifactsRepository(this.manager);
    this.attachments = new AttachmentsRepository(this.manager);
    this.routines = new RoutinesRepository(this.manager);
    this.timers = new TimersRepository(this.manager);
    this.pipelines = new PipelinesRepository(this.manager);
    this.orchestration = new OrchestrationRepository(this.manager);
    this.backupManager = new BackupManager(this, this.options.baseDir);
  }

  /**
   * Execute in transaction or nested savepoint.
   * @template T
   * @param {(db: import('node:sqlite').DatabaseSync) => T} fn
   * @returns {T}
   */
  transaction(fn) {
    return this.manager.transaction(fn);
  }

  /**
   * Hot backup database file.
   * @param {string} destPath
   */
  async backup(destPath) {
    return this.manager.backup(destPath);
  }

  close() {
    this.manager.close();
  }
}

/**
 * Factory to create initialized SQLite Storage instance.
 * @param {Object} [options]
 * @param {string} [options.dbPath] - Database file path (defaults to in-memory if omitted)
 * @param {string} [options.migrationsDir] - Custom migrations directory
 * @returns {Storage}
 */
function createStorage(options = {}) {
  const dbPath = options.dbPath || ':memory:';
  const manager = new DatabaseManager(dbPath, {
    migrationsDir: options.migrationsDir || path.join(__dirname, 'migrations'),
    ...options,
  });

  return new Storage(manager, options);
}

module.exports = {
  Storage,
  createStorage,
  DatabaseManager,
  BackupManager,
  closeDatabasesUnder,
};
