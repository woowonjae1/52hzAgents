import { BaseWorkspaceApi } from './base';

export interface LegacyMigrationIssue {
  id: string;
  targetType: 'work_profile' | 'saved_workflow' | 'session';
  name: string;
  field: string;
  currentValue: string;
  reason: string;
  suggestedRole: string;
  details?: Record<string, any>;
}

export interface LegacyMigrationCheckResult {
  needsMigration: boolean;
  stats: {
    totalIssues: number;
    workProfiles: number;
    savedWorkflows: number;
    sessions: number;
  };
  issues: LegacyMigrationIssue[];
  availableAgents: Array<{ id: string; name: string; role: string }>;
  lastMigration: {
    timestamp: string;
    backupPath: string;
    backupChecksum: string;
    migratedCount: number;
  } | null;
}

export interface MigrationResolution {
  id: string;
  targetType: 'work_profile' | 'saved_workflow' | 'session';
  action: 'bind_agent' | 'create_agent' | 'deprecate';
  targetAgentId?: string;
  newAgent?: {
    name: string;
    role?: string;
    description?: string;
    instructions?: string;
    defaultMode?: 'chat' | 'plan' | 'agent';
  };
  details?: Record<string, any>;
}

export interface MigrationExecutionResult {
  success: boolean;
  backup: {
    backupPath: string;
    checksum: string;
  };
  migratedCount: number;
  createdAgents: Array<{ id: string; name: string }>;
  timestamp: string;
}

export class MigrationApi extends BaseWorkspaceApi {
  checkLegacyMigration(): Promise<LegacyMigrationCheckResult> {
    return this.request('/v1/migration/legacy-check');
  }

  executeLegacyMigration(resolutions: MigrationResolution[]): Promise<MigrationExecutionResult> {
    return this.request('/v1/migration/execute', {
      method: 'POST',
      body: JSON.stringify({ resolutions }),
    });
  }

  rollbackLegacyMigration(backupPath: string): Promise<{ success: boolean; restoredFrom: string }> {
    return this.request('/v1/migration/rollback', {
      method: 'POST',
      body: JSON.stringify({ backupPath }),
    });
  }
}
