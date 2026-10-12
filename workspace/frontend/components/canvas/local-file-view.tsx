'use client';

import * as React from 'react';
import {
  FileCode,
  FileText,
  Copy,
  ExternalLink,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { workspaceApi, type FSContentResponse } from '@/lib/api';
import { MarkdownContent } from '../chat/markdown-content';
import { Hint } from '@/components/ui/hint';
import { toast } from '@/lib/toast';
import { copyWithToast } from '@/lib/desktop';

export function LocalFileView({
  path,
  channelId,
  workingDir,
  header,
}: {
  path: string;
  channelId: string;
  workingDir?: string;
  header: (actions: {
    title: string;
    icon: React.ReactNode;
    meta?: string;
    controls?: React.ReactNode;
  }) => React.ReactNode;
}) {
  const [data, setData] = React.useState<FSContentResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    workspaceApi
      .getFSContent(channelId, path)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read file');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, path]);

  const ext = path.split('.').pop()?.toLowerCase() || '';
  const isMd = ext === 'md' || ext === 'mdx';

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleOpenLocal = async () => {
    const fullPath = workingDir ? `${workingDir}/${path}` : path;
    try {
      await workspaceApi.openLocalPath(fullPath);
      toast.success('Opened on host');
    } catch {
      toast.error('Could not open on host');
    }
  };

  const controls = data && (
    <div className="flex items-center gap-1">
      {!data.is_binary && (
        <Hint label="Copy file content">
          <button
            type="button"
            onClick={() => void copyWithToast(data.content, 'File content copied')}
            className="h-7 shrink-0 rounded-lg px-2 flex items-center justify-center gap-1 text-2xs text-foreground-muted hover:bg-surface2 hover:text-foreground transition-colors"
          >
            <Copy className="size-3.5" />
            <span className="hidden sm:inline">Copy</span>
          </button>
        </Hint>
      )}
      {workingDir && (
        <Hint label="Open in default editor / explorer">
          <button
            type="button"
            onClick={() => void handleOpenLocal()}
            className="h-7 shrink-0 rounded-lg px-2 flex items-center justify-center gap-1 text-2xs text-foreground-muted hover:bg-surface2 hover:text-foreground transition-colors"
          >
            <ExternalLink className="size-3.5" />
            <span className="hidden sm:inline">Open</span>
          </button>
        </Hint>
      )}
    </div>
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {header({
        title: path,
        icon: isMd ? <FileText className="size-3.5 text-emerald-400" /> : <FileCode className="size-3.5 text-blue-400" />,
        meta: data ? formatSize(data.size) : undefined,
        controls,
      })}

      <div className="flex-1 min-h-0 overflow-y-auto p-5 lg:p-7">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground gap-2 text-xs">
            <Loader2 className="size-4 animate-spin" />
            Reading {path}…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-48 text-status-danger text-center">
            <AlertCircle className="size-6 mb-2" />
            <p className="text-xs font-semibold">Could not read file</p>
            <p className="text-2xs text-muted-foreground mt-1">{error}</p>
          </div>
        ) : !data ? null : data.is_binary ? (
          <div className="flex flex-col items-center justify-center h-48 text-center text-muted-foreground">
            <FileCode className="size-8 mb-2 opacity-50" />
            <p className="text-xs font-medium text-foreground">Binary file</p>
            <p className="text-2xs mt-1 text-muted-foreground">
              Binary file cannot be previewed as text. Open it with an external application.
            </p>
          </div>
        ) : isMd ? (
          <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
            <MarkdownContent content={data.content} workingDir={workingDir} />
          </div>
        ) : (
          <MarkdownContent content={`\`\`\`${ext}\n${data.content}\n\`\`\``} workingDir={workingDir} />
        )}
      </div>
    </div>
  );
}
