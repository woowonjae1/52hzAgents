import { useEffect, useState } from 'react';
import { FileText, Download, Trash2, Loader2, ChevronLeft, Copy, Check, ExternalLink, Music, Film, FileCode } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { toast } from 'sonner';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { FileGrid } from './file-grid';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isHtmlFile(contentType: string, filename: string): boolean {
  return contentType === 'text/html' || /\.html?$/i.test(filename);
}

function isImageFile(contentType: string, filename: string): boolean {
  return contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filename);
}

function isPdfFile(contentType: string, filename: string): boolean {
  return contentType === 'application/pdf' || /\.pdf$/i.test(filename);
}

function isVideoFile(contentType: string, filename: string): boolean {
  return contentType.startsWith('video/') || /\.(mp4|webm|ogv|mov|mkv)$/i.test(filename);
}

function isAudioFile(contentType: string, filename: string): boolean {
  return contentType.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(filename);
}

function isMarkdownFile(contentType: string, filename: string): boolean {
  return contentType === 'text/markdown' || /\.mdx?$/i.test(filename);
}

function isTextFile(contentType: string, filename: string): boolean {
  if (isHtmlFile(contentType, filename)) return false;
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/javascript' ||
    contentType === 'application/xml' ||
    contentType === 'application/yaml' ||
    contentType === 'application/x-sh' ||
    /\.(md|txt|csv|json|js|ts|tsx|jsx|py|rs|go|java|rb|c|cpp|h|hpp|cs|php|swift|kt|sh|bat|cmd|ps1|yaml|yml|toml|cfg|ini|log|sql|vue|svelte|graphql|prisma|env|dockerfile|lock|xml|svg|css|scss|less)$/i.test(filename)
  );
}

function fixMojibake(text: string): string {
  // Detect classic Windows GBK / UTF-8 double-encoding Mojibake (e.g. 鎴愰兘, 鍩, 鎴, 浜)
  if (/^[\s\S]{0,150}(?:鎴愰兘|鍩|鎴|浜|澶|绠|闈|娲|琛|矾|绾|缁)/.test(text)) {
    try {
      const bytes = new Uint8Array(Array.from(text).map((c) => c.charCodeAt(0) & 0xff));
      const decoder = new TextDecoder('utf-8');
      const decoded = decoder.decode(bytes);
      if (decoded && !decoded.includes('\ufffd') && decoded.length > 0) {
        return decoded;
      }
    } catch {}
  }
  return text;
}

export function FilePreview() {
  const { files, selectedFileId, deleteFile, setSelectedFileId } = useWorkspace();
  const { isMobile, openMobileList } = useLayout();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const file = files.find((f) => f.id === selectedFileId);

  // Cleanup blob URLs
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  // Load file content when selection changes
  useEffect(() => {
    if (!file) {
      setContent(null);
      setBlobUrl(null);
      return;
    }

    const ct = file.contentType || '';
    const fn = file.filename || '';
    const isHtml = isHtmlFile(ct, fn);
    const isImage = isImageFile(ct, fn);
    const isPdf = isPdfFile(ct, fn);
    const isVideo = isVideoFile(ct, fn);
    const isAudio = isAudioFile(ct, fn);
    const isText = isTextFile(ct, fn);

    // Direct blob/URL types
    if (isHtml || isPdf || isVideo || isAudio) {
      setContent(null);
      const url = workspaceApi.getFileUrl(file.id);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setBlobUrl(url);
      setLoading(false);
      return;
    }

    // Only skip fetch for known compiled binary archive/executable files
    const isKnownBinary = /\.(zip|gz|tar|tgz|7z|rar|exe|dll|so|dylib|bin|iso|dmg|apk|ipa|woff2?|ttf|eot|otf)$/i.test(fn);
    if (isKnownBinary) {
      setContent(null);
      setBlobUrl(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const url = workspaceApi.getFileUrl(file.id);
    const headers: Record<string, string> = {};
    const token = (workspaceApi as unknown as { token: string }).token;
    if (token) headers['X-Workspace-Token'] = token;

    fetch(url, { headers })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        if (isImage) {
          const blob = await res.blob();
          if (!cancelled) {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            setBlobUrl(URL.createObjectURL(blob));
            setContent(null);
          }
        } else {
          const text = await res.text();
          if (!cancelled) {
            setContent(fixMojibake(text));
            setBlobUrl(null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent(null);
          setBlobUrl(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [file?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!file) {
    return <FileGrid />;
  }

  const handleDownload = () => {
    const url = workspaceApi.getFileUrl(file.id);
    window.open(url, '_blank');
  };

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async () => {
    try {
      await deleteFile(file.id);
      toast.success(`Deleted ${file.filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const ct = file.contentType || '';
  const fn = file.filename || '';
  const isHtml = isHtmlFile(ct, fn);
  const isImage = isImageFile(ct, fn);
  const isPdf = isPdfFile(ct, fn);
  const isVideo = isVideoFile(ct, fn);
  const isAudio = isAudioFile(ct, fn);
  const isMarkdown = isMarkdownFile(ct, fn);

  const lines = content ? content.split('\n') : [];

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 pl-2 lg:pl-4 pr-12 py-2 lg:py-3 border-b shrink-0 bg-background/50">
        <button
          onClick={() => {
            if (isMobile) openMobileList();
            else setSelectedFileId(null);
          }}
          className="size-8 flex items-center justify-center rounded-lg hover:bg-surface2 text-muted-foreground transition-colors shrink-0 cursor-pointer"
          title="Back to files"
        >
          <ChevronLeft className="size-5" />
        </button>
        <FileText className="size-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate text-foreground">{file.filename.split('/').pop() || file.filename}</p>
          <p className="text-xs text-muted-foreground truncate">
            {file.filename.includes('/') && (
              <span className="text-muted-foreground/60">{file.filename.split('/').slice(0, -1).join('/')}/ · </span>
            )}
            {formatSize(file.size)} · {file.contentType || 'file'} · {(file.uploadedBy || 'unknown').replace(/^(openagents:|human:)/, '')}
          </p>
        </div>

        {content !== null && (
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg hover:bg-surface2 text-muted-foreground transition-colors cursor-pointer"
            title="Copy content"
          >
            {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
          </button>
        )}

        <button
          onClick={handleDownload}
          className="p-1.5 rounded-lg hover:bg-surface2 text-muted-foreground transition-colors cursor-pointer"
          title="Open in new tab / Download"
        >
          <ExternalLink className="size-4" />
        </button>

        <button
          onClick={handleDelete}
          className="p-1.5 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-red-500 transition-colors cursor-pointer"
          title="Delete"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {/* Content Body */}
      <div className="flex-1 overflow-auto bg-background">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : isHtml && blobUrl ? (
          <iframe
            src={blobUrl}
            title={file.filename}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin"
          />
        ) : isPdf && blobUrl ? (
          <iframe
            src={blobUrl}
            title={file.filename}
            className="w-full h-full border-0"
          />
        ) : isVideo && blobUrl ? (
          <div className="flex items-center justify-center p-4 h-full bg-black/90">
            <video src={blobUrl} controls autoPlay className="max-w-full max-h-full rounded-lg shadow-lg" />
          </div>
        ) : isAudio && blobUrl ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
            <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <Music className="size-8 animate-pulse" />
            </div>
            <p className="font-medium text-sm text-foreground">{file.filename}</p>
            <audio src={blobUrl} controls className="w-80 max-w-full" />
          </div>
        ) : blobUrl && isImage ? (
          <div className="flex items-center justify-center p-4 h-full bg-primary/5">
            <img
              src={blobUrl}
              alt={file.filename}
              className="max-w-full max-h-full object-contain rounded-lg shadow-md"
            />
          </div>
        ) : content !== null && isMarkdown ? (
          <div className="p-6 max-w-4xl mx-auto text-sm leading-relaxed">
            <MarkdownContent content={content} agentNames={[]} />
          </div>
        ) : content !== null ? (
          <div className="flex text-xs font-mono min-h-full">
            {/* Line numbers gutter */}
            <div className="select-none py-4 px-3 text-right text-foreground-extra-muted bg-muted/30 border-r border-border shrink-0 min-w-[40px]">
              {lines.map((_, i) => (
                <div key={i} className="leading-6">{i + 1}</div>
              ))}
            </div>
            {/* Code content */}
            <pre className="p-4 leading-6 whitespace-pre-wrap break-words flex-1 text-foreground overflow-x-auto">
              {content}
            </pre>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <FileText className="size-10 opacity-30" />
            <p className="text-sm font-medium">Preview not available for this file type</p>
            <button
              onClick={handleDownload}
              className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
            >
              Download file
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
