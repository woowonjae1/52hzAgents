import type {
  SkillCatalogEntry,
  Workspace,
  WorkspaceCollaborator,
  WorkspaceCustomSkill,
  WorkspaceInvitation,
} from '../types';
import { BaseWorkspaceApi } from './base';

export function mapCustomSkill(raw: Record<string, unknown>): WorkspaceCustomSkill {
  return {
    id: raw.id as string,
    name: (raw.name || raw.id) as string,
    description: (raw.description as string) || '',
    category: 'custom',
    tags: (raw.tags as string[]) || [],
    author: (raw.author as string) || 'Workspace user',
    sourceType: 'workspace_file',
    fileId: (raw.file_id || raw.fileId) as string,
    filename: (raw.filename as string) || '',
    contentType: (raw.content_type || raw.contentType) as string | undefined,
    packageType: (raw.package_type || raw.packageType || 'md') as 'md' | 'zip',
    createdAt: (raw.created_at || raw.createdAt) as string | undefined,
  };
}

export class WorkspacesApi extends BaseWorkspaceApi {
  async getWorkspace(): Promise<Workspace> {
    return this.request<Workspace>(`/v1/workspaces/${this.workspaceId}`);
  }

  async updateWorkspace(updates: { name?: string; settings?: Record<string, unknown>; browserfabric_api_key?: string }): Promise<Workspace> {
    return this.request<Workspace>(`/v1/workspaces/${this.workspaceId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async claimWorkspace(): Promise<Workspace> {
    return this.request<Workspace>(`/v1/workspaces/${this.workspaceId}/claim`, {
      method: 'POST',
    });
  }

  async updateMember(agentName: string, updates: { description?: string; role?: string; autostart?: boolean; enabled_skills?: Record<string, boolean> }): Promise<unknown> {
    return this.request(`/v1/workspaces/${this.workspaceId}/members/${agentName}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async generateMemberDescription(agentName: string): Promise<string> {
    const raw = await this.request<{ agentName: string; description: string }>(
      `/v1/workspaces/${this.workspaceId}/members/${agentName}/generate-description`,
      { method: 'POST' },
    );
    return raw.description || '';
  }

  async getSkillCatalog(): Promise<SkillCatalogEntry[]> {
    return this.request<SkillCatalogEntry[]>('/v1/workspaces/skill-catalog');
  }

  async installSkill(agentName: string, skillId: string): Promise<unknown> {
    return this.request(`/v1/workspaces/${this.workspaceId}/members/${agentName}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ skill_id: skillId }),
    });
  }

  async uninstallSkill(agentName: string, skillId: string): Promise<unknown> {
    return this.request(`/v1/workspaces/${this.workspaceId}/members/${agentName}/skills/uninstall`, {
      method: 'POST',
      body: JSON.stringify({ skill_id: skillId }),
    });
  }

  async getCustomSkills(): Promise<WorkspaceCustomSkill[]> {
    const raw = await this.request<{ skills: Record<string, unknown>[] }>(
      `/v1/workspaces/${this.workspaceId}/skills/custom`,
    );
    return (raw.skills || []).map(mapCustomSkill);
  }

  async registerCustomSkill(meta: {
    fileId: string;
    id?: string;
    name?: string;
    description?: string;
    filename?: string;
  }): Promise<WorkspaceCustomSkill> {
    const raw = await this.request<Record<string, unknown>>(
      `/v1/workspaces/${this.workspaceId}/skills/custom`,
      {
        method: 'POST',
        body: JSON.stringify({
          file_id: meta.fileId,
          id: meta.id,
          name: meta.name,
          description: meta.description,
          filename: meta.filename,
        }),
      },
    );
    return mapCustomSkill(raw);
  }

  async uploadCustomSkill(
    file: File,
    meta: { id?: string; name?: string; description?: string },
  ): Promise<WorkspaceCustomSkill> {
    // uploadFile will be accessible on the composite class
    const uploaded = await (this as unknown as { uploadFile: (f: File) => Promise<{ id: string }> }).uploadFile(file);
    return this.registerCustomSkill({
      fileId: uploaded.id,
      id: meta.id,
      name: meta.name,
      description: meta.description,
      filename: file.name,
    });
  }

  async updateChannel(channelName: string, updates: { title?: string; status?: string; starred?: boolean; masterAgent?: string; orchestrationMode?: string; orchestrationInstruction?: string | null; workingDir?: string | null; verificationCmd?: string | null }): Promise<unknown> {
    const { masterAgent, orchestrationMode, orchestrationInstruction, workingDir, verificationCmd, ...rest } = updates;
    const body: Record<string, unknown> = { ...rest };
    if (masterAgent !== undefined) body.master_agent = masterAgent;
    if (orchestrationMode !== undefined) body.orchestration_mode = orchestrationMode;
    if (orchestrationInstruction !== undefined) body.orchestration_instruction = orchestrationInstruction;
    if (workingDir !== undefined) body.working_dir = workingDir ?? '';
    if (verificationCmd !== undefined) body.verification_cmd = verificationCmd ?? '';
    return this.request(`/v1/workspaces/${this.workspaceId}/channels/${channelName}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async listCollaborators(): Promise<{ collaborators: WorkspaceCollaborator[]; owner: string | null }> {
    return this.request<{ collaborators: WorkspaceCollaborator[]; owner: string | null }>(
      `/v1/workspaces/${this.workspaceId}/collaborators`
    );
  }

  async addCollaborator(email: string, role: string = 'editor'): Promise<WorkspaceCollaborator> {
    return this.request<WorkspaceCollaborator>(`/v1/workspaces/${this.workspaceId}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
  }

  async removeCollaborator(email: string): Promise<void> {
    await this.request<unknown>(`/v1/workspaces/${this.workspaceId}/collaborators/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    });
  }

  async createInvitation(_targetAgentName: string, _expiresInHours = 168): Promise<WorkspaceInvitation> {
    throw new Error('Invitations are not yet available in event-native mode');
  }

  async listInvitations(_status?: string): Promise<WorkspaceInvitation[]> {
    return [];
  }

  async getChannelPipeline(channelId: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    return this.request<Record<string, unknown>>(`/v1/channels/${channelId}/pipeline?${params}`);
  }

  async haltChannelPipeline(channelId: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    return this.request<Record<string, unknown>>(`/v1/channels/${channelId}/pipeline/halt?${params}`, {
      method: 'POST',
    });
  }
}
