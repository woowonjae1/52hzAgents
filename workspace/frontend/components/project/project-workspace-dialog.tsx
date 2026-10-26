'use client';

import * as React from 'react';
import {
  FolderGit2,
  FileText,
  BookOpen,
  Clock,
  Folder,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Plus,
  Trash2,
  Play,
  Pause,
  AlertCircle,
  Save,
  CheckCircle2,
  Calendar,
  Layers,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Hint } from '@/components/ui/hint';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  getProjectName,
  getProjectInstructions,
  saveProjectInstructions,
  getProjectCategory,
  isKnowledgeForProject,
  isRoutineForProject,
  INSTRUCTION_TEMPLATES,
} from '@/lib/project-workspace';

export interface ProjectWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dir: string;
}

type TabType = 'instructions' | 'knowledge' | 'routines' | 'files';

export function ProjectWorkspaceDialog({
  open,
  onOpenChange,
  dir,
}: ProjectWorkspaceDialogProps) {
  const {
    sessions,
    knowledge,
    createKnowledge,
    deleteKnowledge,
    routines,
    toggleRoutine,
    triggerRoutine,
    createRoutine,
    setSessionOrchestration,
    activeSessionIds,
  } = useWorkspace();

  const [activeTab, setActiveTab] = React.useState<TabType>('instructions');
  const [copied, setCopied] = React.useState(false);

  // Instructions State
  const [instructions, setInstructions] = React.useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = React.useState(false);
  const [savingInstructions, setSavingInstructions] = React.useState(false);

  // Knowledge State
  const [showAddKnowledge, setShowAddKnowledge] = React.useState(false);
  const [newKnowledgeTitle, setNewKnowledgeTitle] = React.useState('');
  const [newKnowledgeContent, setNewKnowledgeContent] = React.useState('');
  const [addingKnowledge, setAddingKnowledge] = React.useState(false);

  // Routine State
  const [showAddRoutine, setShowAddRoutine] = React.useState(false);
  const [routineName, setRoutineName] = React.useState('');
  const [routineMessage, setRoutineMessage] = React.useState('');
  const [routineInterval, setRoutineInterval] = React.useState(60);
  const [creatingRoutine, setCreatingRoutine] = React.useState(false);

  const projectName = React.useMemo(() => getProjectName(dir), [dir]);

  // Project Sessions
  const projectSessions = React.useMemo(() => {
    return sessions.filter((s) => s.workingDir === dir);
  }, [sessions, dir]);

  const projectSessionIds = React.useMemo(() => {
    return new Set(projectSessions.map((s) => s.sessionId));
  }, [projectSessions]);

  // Load Instructions on open or dir change
  React.useEffect(() => {
    if (open && dir) {
      const saved = getProjectInstructions(dir);
      setInstructions(saved);
      setHasUnsavedChanges(false);
    }
  }, [open, dir]);

  const handleCopyPath = () => {
    if (!dir) return;
    navigator.clipboard.writeText(dir);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success('Project path copied to clipboard');
  };

  const handleRevealExplorer = async () => {
    if (!dir) return;
    try {
      await workspaceApi.openLocalPath(dir);
    } catch {
      toast.error('Could not reveal folder in host file manager');
    }
  };

  const handleSaveInstructions = async () => {
    if (!dir) return;
    setSavingInstructions(true);
    try {
      saveProjectInstructions(dir, instructions);

      // Auto-sync instructions to all active sessions in this project
      const targetSessions = projectSessions.filter((s) => s.status === 'active');
      let syncCount = 0;
      for (const s of targetSessions) {
        try {
          await setSessionOrchestration(s.sessionId, { instruction: instructions || null });
          syncCount++;
        } catch {
          // Best effort sync per session
        }
      }

      setHasUnsavedChanges(false);
      toast.success(
        syncCount > 0
          ? `Project instructions saved & synced to ${syncCount} conversation${syncCount > 1 ? 's' : ''}`
          : 'Project instructions saved successfully'
      );
    } catch {
      toast.error('Failed to save instructions');
    } finally {
      setSavingInstructions(false);
    }
  };

  // Filtered Project Knowledge
  const projectKnowledge = React.useMemo(() => {
    return knowledge.filter((k) => isKnowledgeForProject(k, dir));
  }, [knowledge, dir]);

  const handleCreateKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKnowledgeTitle.trim() || !newKnowledgeContent.trim()) {
      toast.error('Please enter both title and content');
      return;
    }
    setAddingKnowledge(true);
    try {
      await createKnowledge({
        title: newKnowledgeTitle.trim(),
        content: newKnowledgeContent.trim(),
        category: getProjectCategory(dir),
        description: `Project knowledge for ${projectName} (${dir})`,
      });
      setNewKnowledgeTitle('');
      setNewKnowledgeContent('');
      setShowAddKnowledge(false);
      toast.success('Knowledge document added to project');
    } catch {
      toast.error('Failed to create knowledge entry');
    } finally {
      setAddingKnowledge(false);
    }
  };

  const handleDeleteKnowledge = async (id: string) => {
    try {
      await deleteKnowledge(id);
      toast.success('Knowledge document removed');
    } catch {
      toast.error('Failed to delete knowledge document');
    }
  };

  // Filtered Project Routines
  const projectRoutines = React.useMemo(() => {
    return routines.filter((r) => isRoutineForProject(r, dir, projectSessionIds));
  }, [routines, dir, projectSessionIds]);

  const handleCreateRoutine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!routineName.trim() || !routineMessage.trim()) {
      toast.error('Please enter name and instruction');
      return;
    }
    setCreatingRoutine(true);
    try {
      await createRoutine({
        name: routineName.trim(),
        message: routineMessage.trim(),
        source: 'user',
        interval_minutes: routineInterval,
        context: dir,
      });
      setRoutineName('');
      setRoutineMessage('');
      setShowAddRoutine(false);
      toast.success('Project routine created');
    } catch {
      toast.error('Failed to create project routine');
    } finally {
      setCreatingRoutine(false);
    }
  };

  const tabOptions = [
    { value: 'instructions' as const, label: 'Instructions', icon: FileText },
    {
      value: 'knowledge' as const,
      label: `Knowledge (${projectKnowledge.length})`,
      icon: BookOpen,
    },
    {
      value: 'routines' as const,
      label: `Automations (${projectRoutines.length})`,
      icon: Clock,
    },
    { value: 'files' as const, label: 'Files', icon: Folder },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] p-0 flex flex-col overflow-hidden bg-surface0 border-border/80 shadow-2xl rounded-2xl">
        {/* Header */}
        <div className="px-6 pr-14 pt-5 pb-4 border-b border-border/60 bg-surface1/60 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary border border-primary/20 shrink-0 shadow-xs">
                <FolderGit2 className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <DialogTitle className="text-base font-semibold text-foreground truncate">
                    {projectName}
                  </DialogTitle>
                  <span className="text-2xs font-mono px-2 py-0.5 rounded-full bg-surface2 text-muted-foreground border border-border/60 shrink-0">
                    Project Workspace
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground min-w-0">
                  <span className="truncate font-mono text-2xs select-all">{dir}</span>
                  <Hint label={copied ? 'Copied' : 'Copy path'}>
                    <button
                      type="button"
                      onClick={handleCopyPath}
                      className="p-1 rounded hover:bg-surface2 text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                    >
                      {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                    </button>
                  </Hint>
                  <Hint label="Reveal in File Explorer">
                    <button
                      type="button"
                      onClick={handleRevealExplorer}
                      className="p-1 rounded hover:bg-surface2 text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                    >
                      <ExternalLink className="size-3" />
                    </button>
                  </Hint>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-2xs text-muted-foreground shrink-0">
              <span className="flex items-center gap-1 bg-surface2 px-2 py-1 rounded-md border border-border/50">
                <Layers className="size-3 text-primary" />
                <span>{projectSessions.length} conversation{projectSessions.length !== 1 ? 's' : ''}</span>
              </span>
            </div>
          </div>

          {/* Segmented Tab Navigation */}
          <div className="mt-4">
            <SegmentedControl
              options={tabOptions}
              value={activeTab}
              onValueChange={setActiveTab}
              size="sm"
              className="w-full justify-start bg-surface2/70 p-0.5"
            />
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-surface0">
          {/* TAB 1: INSTRUCTIONS */}
          {activeTab === 'instructions' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <FileText className="size-4 text-primary" />
                    Project System Instructions
                  </h3>
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    Persistent instructions and guidelines automatically applied to agents working in this project.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={savingInstructions || !hasUnsavedChanges}
                  onClick={handleSaveInstructions}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-1.5 rounded-lg transition-all shadow-xs',
                    hasUnsavedChanges
                      ? 'bg-primary text-primary-foreground hover:opacity-90 ring-1 ring-primary/40'
                      : 'bg-surface2 text-muted-foreground cursor-not-allowed opacity-60'
                  )}
                >
                  <Save className="size-3.5" />
                  {savingInstructions ? 'Saving…' : 'Save Instructions'}
                </button>
              </div>

              {/* Template Quick Inserts */}
              <div className="space-y-1.5">
                <span className="text-2xs font-medium text-muted-foreground flex items-center gap-1">
                  <Sparkles className="size-3 text-primary" />
                  Insert template:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {INSTRUCTION_TEMPLATES.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      type="button"
                      onClick={() => {
                        setInstructions((prev) => (prev ? `${prev}\n\n${tmpl.content}` : tmpl.content));
                        setHasUnsavedChanges(true);
                      }}
                      className="text-2xs px-2.5 py-1 rounded-md bg-surface2 hover:bg-surface3 border border-border/60 text-foreground transition-colors hover:border-primary/40"
                      title={tmpl.description}
                    >
                      {tmpl.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Textarea */}
              <div className="relative">
                <textarea
                  value={instructions}
                  onChange={(e) => {
                    setInstructions(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  rows={10}
                  placeholder="Define technical conventions, test commands, architectural patterns, and guidelines for this repository..."
                  className="w-full rounded-xl bg-surface1 border border-border/80 p-3.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all font-mono leading-relaxed"
                />
                <div className="flex items-center justify-between text-3xs text-muted-foreground mt-1 px-1">
                  <span>
                    {hasUnsavedChanges ? (
                      <span className="text-status-warning font-medium">Unsaved changes</span>
                    ) : (
                      <span className="text-status-success font-medium inline-flex items-center gap-1">
                        <CheckCircle2 className="size-2.5" /> Saved
                      </span>
                    )}
                  </span>
                  <span>{instructions.length} characters</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: KNOWLEDGE & MEMORY */}
          {activeTab === 'knowledge' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <BookOpen className="size-4 text-primary" />
                    Project Knowledge & Memory
                  </h3>
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    Technical documents, architecture specs, and long-term context stored for this project.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddKnowledge(!showAddKnowledge)}
                  className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 border border-border text-foreground transition-colors"
                >
                  <Plus className="size-3.5 text-primary" />
                  {showAddKnowledge ? 'Cancel' : 'Add Note'}
                </button>
              </div>

              {/* Add Knowledge Form */}
              {showAddKnowledge && (
                <form
                  onSubmit={handleCreateKnowledge}
                  className="p-4 rounded-xl bg-surface1 border border-border/80 space-y-3"
                >
                  <h4 className="text-xs font-medium text-foreground">Add Project Knowledge</h4>
                  <input
                    type="text"
                    value={newKnowledgeTitle}
                    onChange={(e) => setNewKnowledgeTitle(e.target.value)}
                    placeholder="Document title (e.g. Architecture Overview, API Spec)..."
                    className="w-full px-3 py-1.5 rounded-lg bg-surface2 border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <textarea
                    value={newKnowledgeContent}
                    onChange={(e) => setNewKnowledgeContent(e.target.value)}
                    rows={4}
                    placeholder="Markdown content, schema definitions, or domain notes..."
                    className="w-full px-3 py-2 rounded-lg bg-surface2 border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary font-mono"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddKnowledge(false)}
                      className="px-3 py-1 text-xs rounded-md text-muted-foreground hover:bg-surface2"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={addingKnowledge}
                      className="px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {addingKnowledge ? 'Saving…' : 'Save to Project'}
                    </button>
                  </div>
                </form>
              )}

              {/* Knowledge List */}
              {projectKnowledge.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-8 rounded-xl border border-dashed border-border text-center">
                  <BookOpen className="size-8 text-muted-foreground/40 mb-2" />
                  <p className="text-xs font-medium text-foreground">No project memory yet</p>
                  <p className="text-2xs text-muted-foreground mt-1 max-w-sm">
                    Store project-specific architectural guidelines, APIs, or domain rules so agents can recall them during tasks.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddKnowledge(true)}
                    className="mt-3 text-xs font-medium text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <Plus className="size-3" /> Add first note
                  </button>
                </div>
              ) : (
                <div className="grid gap-2.5">
                  {projectKnowledge.map((item) => (
                    <div
                      key={item.id}
                      className="p-3.5 rounded-xl bg-surface1 border border-border/70 hover:border-border transition-colors flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <h4 className="text-xs font-semibold text-foreground truncate">{item.title}</h4>
                        <p className="text-2xs text-muted-foreground line-clamp-2 leading-relaxed">
                          {item.description || 'Project knowledge note'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteKnowledge(item.id)}
                        className="p-1.5 rounded hover:bg-surface2 text-muted-foreground hover:text-status-danger transition-colors shrink-0"
                        title="Delete note"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: ROUTINES & AUTOMATIONS */}
          {activeTab === 'routines' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <Clock className="size-4 text-primary" />
                    Project Automations & Routines
                  </h3>
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    Scheduled routines and recurring background tasks scoped to this project workspace.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddRoutine(!showAddRoutine)}
                  className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 border border-border text-foreground transition-colors"
                >
                  <Plus className="size-3.5 text-primary" />
                  {showAddRoutine ? 'Cancel' : 'New Routine'}
                </button>
              </div>

              {/* Add Routine Form */}
              {showAddRoutine && (
                <form
                  onSubmit={handleCreateRoutine}
                  className="p-4 rounded-xl bg-surface1 border border-border/80 space-y-3"
                >
                  <h4 className="text-xs font-medium text-foreground">Create Project Routine</h4>
                  <input
                    type="text"
                    value={routineName}
                    onChange={(e) => setRoutineName(e.target.value)}
                    placeholder="Routine name (e.g. Daily Bug Triage, Hourly Build Check)..."
                    className="w-full px-3 py-1.5 rounded-lg bg-surface2 border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <textarea
                    value={routineMessage}
                    onChange={(e) => setRoutineMessage(e.target.value)}
                    rows={3}
                    placeholder="Agent instruction to execute periodically..."
                    className="w-full px-3 py-2 rounded-lg bg-surface2 border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-2xs text-muted-foreground">Interval:</span>
                    <select
                      value={routineInterval}
                      onChange={(e) => setRoutineInterval(Number(e.target.value))}
                      className="px-2 py-1 rounded bg-surface2 border border-border text-xs text-foreground"
                    >
                      <option value={15}>Every 15 minutes</option>
                      <option value={30}>Every 30 minutes</option>
                      <option value={60}>Every hour</option>
                      <option value={360}>Every 6 hours</option>
                      <option value={1440}>Every 24 hours</option>
                    </select>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAddRoutine(false)}
                      className="px-3 py-1 text-xs rounded-md text-muted-foreground hover:bg-surface2"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={creatingRoutine}
                      className="px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {creatingRoutine ? 'Creating…' : 'Create Routine'}
                    </button>
                  </div>
                </form>
              )}

              {/* Routine List */}
              {projectRoutines.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-8 rounded-xl border border-dashed border-border text-center">
                  <Clock className="size-8 text-muted-foreground/40 mb-2" />
                  <p className="text-xs font-medium text-foreground">No automations configured</p>
                  <p className="text-2xs text-muted-foreground mt-1 max-w-sm">
                    Automate code reviews, nightly test suites, or periodic health monitoring for this project.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddRoutine(true)}
                    className="mt-3 text-xs font-medium text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <Plus className="size-3" /> Schedule first routine
                  </button>
                </div>
              ) : (
                <div className="grid gap-2.5">
                  {projectRoutines.map((routine) => {
                    const isActive = routine.status === 'active';
                    return (
                      <div
                        key={routine.id}
                        className="p-3.5 rounded-xl bg-surface1 border border-border/70 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-foreground truncate">{routine.name}</span>
                            <span
                              className={cn(
                                'text-[10px] font-mono px-1.5 py-0.5 rounded-sm capitalize',
                                isActive ? 'bg-status-success/10 text-status-success' : 'bg-surface2 text-muted-foreground'
                              )}
                            >
                              {routine.status}
                            </span>
                          </div>
                          <p className="text-2xs text-muted-foreground truncate">{routine.message}</p>
                          <div className="flex items-center gap-2 text-3xs text-muted-foreground font-mono">
                            {routine.scheduleIntervalMinutes ? (
                              <span>Every {routine.scheduleIntervalMinutes}m</span>
                            ) : (
                              <span>Daily at {String(routine.scheduleHour).padStart(2, '0')}:{String(routine.scheduleMinute).padStart(2, '0')}</span>
                            )}
                            {routine.runCount ? <span>• {routine.runCount} runs</span> : null}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <Hint label="Trigger routine now">
                            <button
                              type="button"
                              onClick={() => void triggerRoutine(routine.id)}
                              className="p-1.5 rounded hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <Play className="size-3.5 text-primary" />
                            </button>
                          </Hint>
                          <Hint label={isActive ? 'Pause routine' : 'Resume routine'}>
                            <button
                              type="button"
                              onClick={() => void toggleRoutine(routine.id)}
                              className="p-1.5 rounded hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {isActive ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                            </button>
                          </Hint>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: FILES */}
          {activeTab === 'files' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                  <Folder className="size-4 text-primary" />
                  Local Repository Files
                </h3>
                <p className="text-2xs text-muted-foreground mt-0.5">
                  Project directory structure and quick file actions.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-surface1 border border-border/80 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <span className="text-2xs font-medium text-muted-foreground uppercase tracking-wider">Root Path</span>
                    <p className="text-xs font-mono text-foreground break-all mt-0.5">{dir}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleCopyPath}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-surface2 hover:bg-surface3 border border-border text-foreground transition-colors"
                    >
                      <Copy className="size-3" />
                      Copy Path
                    </button>
                    <button
                      type="button"
                      onClick={handleRevealExplorer}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                    >
                      <ExternalLink className="size-3" />
                      Open Folder
                    </button>
                  </div>
                </div>

                <div className="h-px bg-border/60 my-2" />

                <div className="flex items-center justify-between text-2xs text-muted-foreground">
                  <span>Linked Conversations: {projectSessions.length}</span>
                  <span className="italic">Use File Tree in the main view for full multi-tier browsing</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
