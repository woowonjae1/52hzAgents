import { BaseWorkspaceApi } from './api/base';
import { WorkspacesApi, mapCustomSkill } from './api/workspaces';
import { EventsApi } from './api/events';
import { FilesApi, mapFileResponse } from './api/files';
import { BrowserApi } from './api/browser';
import { KnowledgeApi } from './api/knowledge';
import { PlanningApi, parseScheduleDays } from './api/planning';
import { AgentsApi } from './api/agents';
import { GitApi } from './api/git';

export { mapCustomSkill, parseScheduleDays, mapFileResponse };

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
  GitApi {}

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
]);

export const workspaceApi = new WorkspaceApi();
