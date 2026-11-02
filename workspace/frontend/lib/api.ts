import { BaseWorkspaceApi } from './api/base';
import { WorkspacesApi, mapCustomSkill } from './api/workspaces';
import { EventsApi } from './api/events';
import { FilesApi, mapFileResponse, type FSEntry, type FSTreeResponse, type FSContentResponse } from './api/files';
import { BrowserApi } from './api/browser';
import { KnowledgeApi } from './api/knowledge';
import { PlanningApi, parseScheduleDays } from './api/planning';
import { AgentsApi } from './api/agents';
import { GitApi } from './api/git';
import { OrchestrationApi } from './api/orchestration';
import { ActivityApi } from './api/activity';
import { AgentDefinitionsApi } from './api/agent-definitions';
export type { AgentDefinition, AgentIdentityInput, AgentExecutionPolicy, AgentModelResource, AgentPermissions, AgentLimits } from './api/agent-definitions';

export { mapCustomSkill, parseScheduleDays, mapFileResponse };
export type { FSEntry, FSTreeResponse, FSContentResponse };

function applyMixins(derivedCtor: any, constructors: any[]) {
  constructors.forEach((baseCtor) => {
    Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {
      if (name !== 'constructor') {
        Object.defineProperty(
          derivedCtor.prototype,
          name,
          Object.getOwnPropertyDescriptor(baseCtor.prototype, name) || Object.create(null)
        );
      }
    });
  });
}

export interface WorkspaceApi extends
  BaseWorkspaceApi,
  WorkspacesApi,
  EventsApi,
  FilesApi,
  BrowserApi,
  KnowledgeApi,
  PlanningApi,
  AgentsApi,
  GitApi,
  OrchestrationApi,
  ActivityApi,
  AgentDefinitionsApi {}

export class WorkspaceApi extends BaseWorkspaceApi {}

applyMixins(WorkspaceApi, [
  WorkspacesApi,
  EventsApi,
  FilesApi,
  BrowserApi,
  KnowledgeApi,
  PlanningApi,
  AgentsApi,
  GitApi,
  OrchestrationApi,
  ActivityApi,
  AgentDefinitionsApi,
]);

export const workspaceApi = new WorkspaceApi();
