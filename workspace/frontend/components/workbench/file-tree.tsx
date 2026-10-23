'use client';

import * as React from 'react';
import { useState, useMemo, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  FileJson,
  File,
  ChevronRight,
  ChevronDown,
  ChevronsUpDown,
  Search,
  X,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';
import type { GitFileChange } from '@/lib/use-git-status';

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  status?: string;
  staged?: boolean;
  additions?: number;
  deletions?: number;
  children?: FileTreeNode[];
  commentCount?: number;
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'c':
    case 'cpp':
    case 'java':
    case 'rb':
    case 'php':
    case 'swift':
      return <FileCode className="size-3.5 text-primary shrink-0" />;
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'xml':
      return <FileJson className="size-3.5 text-status-warning shrink-0" />;
    case 'md':
    case 'txt':
    case 'rst':
      return <FileText className="size-3.5 text-foreground-muted shrink-0" />;
    default:
      return <File className="size-3.5 text-foreground-extra-muted shrink-0" />;
  }
}

function StatusIndicator({ status }: { status?: string }) {
  if (!status) return null;
  const isAdded = status === 'A' || status === '?';
  const isDeleted = status === 'D';
  const isModified = !isAdded && !isDeleted;

  return (
    <span
      className={cn(
        'font-mono text-[9px] font-semibold px-1 rounded',
        isAdded && 'text-diff-addition bg-diff-addition/15',
        isDeleted && 'text-diff-deletion bg-diff-deletion/15',
        isModified && 'text-status-warning bg-status-warning/15'
      )}
    >
      {status === '?' ? 'U' : status}
    </span>
  );
}

interface FileTreeProps {
  files: GitFileChange[];
  selectedPath?: string;
  onSelectFile: (path: string) => void;
  reviewComments?: Array<{ filePath: string }>;
  className?: string;
}

export function FileTree({
  files,
  selectedPath,
  onSelectFile,
  reviewComments,
  className,
}: FileTreeProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

  // Count review comments per file
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (reviewComments) {
      for (const c of reviewComments) {
        counts.set(c.filePath, (counts.get(c.filePath) || 0) + 1);
      }
    }
    return counts;
  }, [reviewComments]);

  // Build tree from flat files
  const rootNodes = useMemo(() => {
    const filteredFiles = files.filter((f) => {
      if (!searchQuery.trim()) return true;
      return f.path.toLowerCase().includes(searchQuery.trim().toLowerCase());
    });

    const root: { [key: string]: any } = {};

    for (const f of filteredFiles) {
      const parts = f.path.replace(/\\/g, '/').split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        const currentPath = parts.slice(0, i + 1).join('/');

        if (isFile) {
          current[part] = {
            id: currentPath,
            name: part,
            path: f.path,
            type: 'file',
            status: f.status,
            staged: f.staged,
            additions: f.additions,
            deletions: f.deletions,
            commentCount: commentCounts.get(f.path) || 0,
          };
        } else {
          if (!current[part]) {
            current[part] = {
              id: currentPath,
              name: part,
              path: currentPath,
              type: 'folder',
              children: {},
            };
          }
          current = current[part].children;
        }
      }
    }

    function convertToArray(obj: { [key: string]: any }): FileTreeNode[] {
      const folders: FileTreeNode[] = [];
      const leafFiles: FileTreeNode[] = [];

      for (const key of Object.keys(obj)) {
        const item = obj[key];
        if (item.type === 'folder') {
          folders.push({
            id: item.id,
            name: item.name,
            path: item.path,
            type: 'folder',
            children: convertToArray(item.children),
          });
        } else {
          leafFiles.push(item);
        }
      }

      folders.sort((a, b) => a.name.localeCompare(b.name));
      leafFiles.sort((a, b) => a.name.localeCompare(b.name));
      return [...folders, ...leafFiles];
    }

    return convertToArray(root);
  }, [files, searchQuery, commentCounts]);

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (collapsedPaths.size === 0) {
      // Collapse all folders
      const allFolders = new Set<string>();
      const gatherFolders = (nodes: FileTreeNode[]) => {
        for (const n of nodes) {
          if (n.type === 'folder') {
            allFolders.add(n.path);
            if (n.children) gatherFolders(n.children);
          }
        }
      };
      gatherFolders(rootNodes);
      setCollapsedPaths(allFolders);
    } else {
      // Expand all
      setCollapsedPaths(new Set());
    }
  }, [collapsedPaths, rootNodes]);

  const renderNode = (node: FileTreeNode, depth = 0) => {
    const isFolder = node.type === 'folder';
    const isExpanded = !collapsedPaths.has(node.path);
    const isSelected = selectedPath === node.path;

    return (
      <div key={node.id} className="select-none">
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (isFolder) {
              toggleFolder(node.path);
            } else {
              onSelectFile(node.path);
            }
          }}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          className={cn(
            'flex items-center gap-1.5 py-1 pr-2 rounded text-2xs cursor-pointer transition-colors group',
            isSelected
              ? 'bg-primary/10 text-primary font-semibold'
              : 'text-foreground/80 hover:bg-surface2/60 hover:text-foreground'
          )}
        >
          {isFolder ? (
            <span className="flex items-center gap-1 text-foreground-extra-muted">
              {isExpanded ? (
                <ChevronDown className="size-3 text-foreground-muted" />
              ) : (
                <ChevronRight className="size-3 text-foreground-muted" />
              )}
              {isExpanded ? (
                <FolderOpen className="size-3.5 text-primary/80 shrink-0" />
              ) : (
                <Folder className="size-3.5 text-primary/80 shrink-0" />
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="w-3" />
              {getFileIcon(node.name)}
            </span>
          )}

          <span className="truncate flex-1 font-mono text-[11px] leading-tight">
            {node.name}
          </span>

          {!isFolder && (
            <div className="flex items-center gap-1 shrink-0 ml-1">
              {Boolean(node.commentCount) && node.commentCount! > 0 && (
                <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded-full bg-primary/20 text-primary text-[9px] font-semibold">
                  <MessageSquare className="size-2.5" />
                  <span>{node.commentCount}</span>
                </span>
              )}
              <StatusIndicator status={node.status} />
            </div>
          )}
        </div>

        {isFolder && isExpanded && node.children && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className={cn('flex flex-col h-full bg-surface0 border-r border-border', className)}>
      {/* Search & Action bar */}
      <div className="flex items-center gap-1.5 p-2 border-b border-border/70 bg-surface1/50 shrink-0">
        <div className="relative flex-1">
          <Search className="size-3 text-foreground-extra-muted absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search changed files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-6 pr-5 py-1 bg-surface2/70 text-foreground text-2xs rounded border border-border/50 outline-hidden placeholder:text-foreground-extra-muted focus:border-primary/50 transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-foreground-extra-muted hover:text-foreground"
            >
              <X className="size-2.5" />
            </button>
          )}
        </div>

        <Hint label={collapsedPaths.size === 0 ? 'Collapse all folders' : 'Expand all folders'}>
          <button
            type="button"
            onClick={toggleAll}
            className="p-1 rounded text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
          >
            <ChevronsUpDown className="size-3.5" />
          </button>
        </Hint>
      </div>

      {/* File Tree List */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {rootNodes.length === 0 ? (
          <div className="py-6 text-center text-3xs text-foreground-extra-muted">
            {searchQuery ? 'No matching files found' : 'No changed files'}
          </div>
        ) : (
          rootNodes.map((node) => renderNode(node))
        )}
      </div>
    </div>
  );
}
