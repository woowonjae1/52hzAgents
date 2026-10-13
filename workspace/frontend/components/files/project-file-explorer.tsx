'use client';

import * as React from 'react';
import {
  Folder,
  FolderOpen,
  Search,
  RefreshCw,
  ExternalLink,
  Plus,
  FileCode,
  FileText,
  File as FileIcon,
  Image,
  AlertCircle,
  X,
  ChevronRight,
  GitBranch,
  Sliders,
} from 'lucide-react';
import { FileTree, FileTreeFolder, FileTreeFile } from '@/components/motion/file-tree';
import { workspaceApi, type FSEntry, type FSTreeResponse } from '@/lib/api';
import type { GitStatus } from '@/lib/use-git-status';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { ProjectWorkspaceDialog } from '@/components/project/project-workspace-dialog';

export interface ProjectFileExplorerProps {
  channelId: string;
  workingDir?: string;
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
  onInsertReference?: (path: string) => void;
  className?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children: TreeNode[];
}

function getFileIconByExtension(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/)) {
    return <Image className="size-3.5 text-purple-400 shrink-0" />;
  }
  if (lower.match(/\.(ts|tsx|js|jsx)$/)) {
    return <FileCode className="size-3.5 text-blue-400 shrink-0" />;
  }
  if (lower.match(/\.(go)$/)) {
    return <FileCode className="size-3.5 text-cyan-400 shrink-0" />;
  }
  if (lower.match(/\.(py)$/)) {
    return <FileCode className="size-3.5 text-amber-400 shrink-0" />;
  }
  if (lower.match(/\.(rs)$/)) {
    return <FileCode className="size-3.5 text-orange-400 shrink-0" />;
  }
  if (lower.match(/\.(json|yaml|yml|toml)$/)) {
    return <FileText className="size-3.5 text-yellow-400 shrink-0" />;
  }
  if (lower.match(/\.(md|mdx|txt|doc|pdf)$/)) {
    return <FileText className="size-3.5 text-emerald-400 shrink-0" />;
  }
  if (lower.match(/\.(css|scss|less|html)$/)) {
    return <FileCode className="size-3.5 text-pink-400 shrink-0" />;
  }
  return <FileIcon className="size-3.5 text-foreground-extra-muted shrink-0" />;
}

function buildTree(entries: FSEntry[]): TreeNode[] {
  const rootNodes: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  // Ensure entries are processed
  for (const entry of entries) {
    const node: TreeNode = {
      name: entry.name,
      path: entry.path,
      isDir: entry.is_dir,
      size: entry.size,
      children: [],
    };
    map.set(entry.path, node);

    const parts = entry.path.split('/');
    if (parts.length === 1) {
      rootNodes.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = map.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  };

  sortNodes(rootNodes);
  return rootNodes;
}

function filterTree(nodes: TreeNode[], search: string, matchedPaths: Set<string>): TreeNode[] {
  if (!search) return nodes;
  const term = search.toLowerCase();
  const res: TreeNode[] = [];

  for (const n of nodes) {
    const matchSelf = n.name.toLowerCase().includes(term) || n.path.toLowerCase().includes(term);
    const filteredChildren = n.children.length > 0 ? filterTree(n.children, search, matchedPaths) : [];
    if (matchSelf || filteredChildren.length > 0) {
      matchedPaths.add(n.path);
      res.push({
        ...n,
        children: filteredChildren,
      });
    }
  }
  return res;
}

export function ProjectFileExplorer({
  channelId,
  workingDir,
  selectedPath,
  onSelectFile,
  onInsertReference,
  className,
}: ProjectFileExplorerProps) {
  const [loading, setLoading] = React.useState(false);
  const [entries, setEntries] = React.useState<FSEntry[]>([]);
  const [search, setSearch] = React.useState('');
  const [gitStatus, setGitStatus] = React.useState<GitStatus | null>(null);
  const [expandedIds, setExpandedIds] = React.useState<string[]>([]);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = React.useState(false);

  const fetchTree = React.useCallback(async () => {
    if (!channelId && !workingDir) return;
    setLoading(true);
    try {
      const res = await workspaceApi.getFSTree(channelId, undefined, 4);
      setEntries(res.entries || []);
    } catch (err) {
      // If error, entries stay empty
    } finally {
      setLoading(false);
    }
  }, [channelId, workingDir]);

  const fetchGit = React.useCallback(async () => {
    if (!channelId) return;
    try {
      const status = await workspaceApi.getGitStatus(channelId);
      setGitStatus(status);
    } catch {
      setGitStatus(null);
    }
  }, [channelId]);

  React.useEffect(() => {
    void fetchTree();
    void fetchGit();
  }, [fetchTree, fetchGit]);

  const gitChangesMap = React.useMemo(() => {
    const map = new Map<string, string>();
    if (gitStatus?.files) {
      for (const f of gitStatus.files) {
        map.set(f.path.replace(/\\/g, '/'), f.status);
      }
    }
    return map;
  }, [gitStatus]);

  const tree = React.useMemo(() => buildTree(entries), [entries]);

  const matchedPaths = React.useMemo(() => new Set<string>(), []);
  const filteredTree = React.useMemo(() => {
    matchedPaths.clear();
    return filterTree(tree, search.trim(), matchedPaths);
  }, [tree, search, matchedPaths]);

  // Auto-expand folders when searching
  React.useEffect(() => {
    if (search.trim() && matchedPaths.size > 0) {
      setExpandedIds(Array.from(matchedPaths));
    }
  }, [search, matchedPaths]);

  const handleOpenLocalPath = async (e: React.MouseEvent, path?: string) => {
    e.stopPropagation();
    const target = path ? (workingDir ? `${workingDir}/${path}` : path) : workingDir;
    if (!target) return;
    try {
      await workspaceApi.openLocalPath(target);
    } catch {
      toast.error('Could not open folder on host');
    }
  };

  const renderNodes = (nodes: TreeNode[]) => {
    return nodes.map((node) => {
      const gitChange = gitChangesMap.get(node.path);

      if (node.isDir) {
        return (
          <FileTreeFolder
            key={`dir:${node.path}`}
            value={node.path}
            name={node.name}
            icon={<Folder className="size-3.5 text-amber-500/80 shrink-0" />}
          >
            {renderNodes(node.children)}
          </FileTreeFolder>
        );
      }

      return (
        <FileTreeFile
          key={`file:${node.path}`}
          value={node.path}
          name={node.name}
          icon={
            <div className="flex items-center gap-1.5 min-w-0">
              {getFileIconByExtension(node.name)}
              {gitChange && (
                <span
                  className={cn(
                    'text-[9px] font-mono font-bold leading-none px-1 py-0.5 rounded-sm',
                    gitChange === 'M' && 'text-amber-400 bg-amber-500/10',
                    gitChange === 'A' && 'text-emerald-400 bg-emerald-500/10',
                    gitChange === 'D' && 'text-rose-400 bg-rose-500/10',
                    gitChange === '?' && 'text-sky-400 bg-sky-500/10'
                  )}
                  title={`Git status: ${gitChange}`}
                >
                  {gitChange}
                </span>
              )}
            </div>
          }
        />
      );
    });
  };

  const dirBasename = workingDir ? workingDir.split(/[\\/]/).filter(Boolean).pop() : null;

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-surface1 text-foreground select-none', className)}>
      {/* Explorer Header */}
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen className="size-4 shrink-0 text-foreground-muted" />
          <span className="truncate text-xs font-semibold tracking-tight text-foreground" title={workingDir || 'Project'}>
            {dirBasename || 'Project Explorer'}
          </span>
          {gitStatus?.branch && (
            <span className="flex items-center gap-1 text-2xs text-muted-foreground font-mono bg-surface2 px-1.5 py-0.5 rounded shrink-0">
              <GitBranch className="size-2.5" />
              {gitStatus.branch}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Hint label="Refresh tree">
            <button
              type="button"
              onClick={() => {
                void fetchTree();
                void fetchGit();
              }}
              disabled={loading}
              className="grid size-6 place-items-center rounded hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            </button>
          </Hint>
          {workingDir && (
            <Hint label="Open in OS Explorer">
              <button
                type="button"
                onClick={(e) => handleOpenLocalPath(e)}
                className="grid size-6 place-items-center rounded hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="size-3" />
              </button>
            </Hint>
          )}
          {workingDir && (
            <Hint label="Project Workspace (Instructions, Memory, Tasks)">
              <button
                type="button"
                onClick={() => setWorkspaceDialogOpen(true)}
                className="grid size-6 place-items-center rounded hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Sliders className="size-3 text-primary" />
              </button>
            </Hint>
          )}
        </div>
      </div>

      {/* Search Filter */}
      <div className="px-2.5 py-1.5 border-b border-border/40 shrink-0">
        <div className="relative flex items-center">
          <Search className="size-3.5 absolute left-2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter files..."
            className="w-full bg-surface2/60 text-xs text-foreground placeholder:text-muted-foreground rounded-md pl-7 pr-6 py-1 outline-none border border-transparent focus:border-border transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 text-muted-foreground hover:text-foreground p-0.5"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Tree Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {!workingDir ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center text-muted-foreground">
            <AlertCircle className="size-6 mb-2 opacity-50" />
            <p className="text-xs font-medium text-foreground">No working directory</p>
            <p className="text-2xs mt-1 text-muted-foreground">
              Bind a project folder in session settings to browse local files.
            </p>
          </div>
        ) : loading && entries.length === 0 ? (
          <div className="space-y-1.5 p-2">
            <div className="h-4 bg-surface2/60 rounded animate-pulse w-3/4" />
            <div className="h-4 bg-surface2/60 rounded animate-pulse w-1/2" />
            <div className="h-4 bg-surface2/60 rounded animate-pulse w-5/6" />
          </div>
        ) : filteredTree.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {search ? 'No files match your search filter.' : 'Empty directory.'}
          </div>
        ) : (
          <FileTree
            value={selectedPath}
            onValueChange={(val) => {
              if (val) onSelectFile?.(val);
            }}
            expandedIds={expandedIds}
            onExpandedChange={setExpandedIds}
            ariaLabel="Project file explorer"
          >
            {renderNodes(filteredTree)}
          </FileTree>
        )}
      </div>

      {/* Footer Info */}
      {workingDir && entries.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border/40 text-[10px] text-muted-foreground flex items-center justify-between shrink-0 font-mono">
          <span>{entries.filter((e) => !e.is_dir).length} files</span>
          {onInsertReference && selectedPath && (
            <button
              type="button"
              onClick={() => onInsertReference(selectedPath)}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Plus className="size-2.5" />
              Insert @ref
            </button>
          )}
        </div>
      )}

      {workingDir && (
        <ProjectWorkspaceDialog
          open={workspaceDialogOpen}
          onOpenChange={setWorkspaceDialogOpen}
          dir={workingDir}
        />
      )}
    </div>
  );
}
