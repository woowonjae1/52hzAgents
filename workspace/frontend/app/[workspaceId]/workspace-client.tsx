'use client';

import { use, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context';
import { ArtifactsProvider } from '@/lib/artifacts-context';
import { LayoutProvider } from '@/components/layout/layout-context';
import { Wrapper } from '@/components/layout/wrapper';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import { SignalMark } from '@/components/brand/signal-mark';
import { Network } from 'lucide-react';

/*
  ONE LOADING SHELL, NOT TWO.

  This was a byte-for-byte copy of the splash in wrapper.tsx, down to the
  `@keyframes loading-bar` block — so the two screens the user sees back to back
  while a workspace opens were maintained separately and could drift. It is
  re-exported from the shell instead, which is also what turned it into the
  app's real frame rather than a centred wordmark; see the note there.
*/
import { WorkspaceLoadingScreen as WorkspaceLoadingSplash } from '@/components/layout/wrapper';
export { WorkspaceLoadingSplash };

function setWorkspaceCookie(slug: string, token: string) {
  const maxAge = 30 * 24 * 60 * 60;
  const shared = `path=/;max-age=${maxAge};samesite=lax`;
  document.cookie = `hz_workspace=${encodeURIComponent(JSON.stringify({ slug, token }))};${shared}`;
  document.cookie = `hz_has_workspace=1;${shared}`;
}

function IdentityGate({ children }: { children: React.ReactNode }) {
  const { currentUser, setUserName } = useWorkspace();

  useEffect(() => {
    if (!currentUser.name.trim()) {
      setUserName('Guest');
    }
  }, [currentUser.name, setUserName]);

  return <>{children}</>;
}

export function WorkspaceContent({ workspaceId }: { workspaceId: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const { user, idToken, loading: authLoading, isOpenAgentsDomain, signIn } = useOpenAgentsAuth();

  useEffect(() => {
    if (token) {
      setWorkspaceCookie(workspaceId, token);
    }
  }, [workspaceId, token]);

  const [mounted, setMounted] = useState(false);
  const [cachedToken, setCachedToken] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      try {
        setCachedToken(localStorage.getItem(`workspace_token_${workspaceId}`) || localStorage.getItem('workspace_token'));
      } catch {}
    }
    setMounted(true);
  }, [token, workspaceId]);

  const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const effectiveInitialToken = token || cachedToken || '';

  if (!mounted) {
    return <WorkspaceLoadingSplash />;
  }

  // Has workspace token in URL, cached in localStorage, or running in local dev / desktop app mode — mount WorkspaceProvider
  if (token || cachedToken || isLocal) {
    return (
      <WorkspaceProvider workspaceId={workspaceId} token={effectiveInitialToken} bearerToken={idToken || undefined}>
        <IdentityGate>
          <ArtifactsProvider>
            <LayoutProvider>
              <Wrapper />
            </LayoutProvider>
          </ArtifactsProvider>
        </IdentityGate>
      </WorkspaceProvider>
    );
  }

  // No token — check if user is logged in via OpenAgents
  if (isOpenAgentsDomain) {
    if (authLoading) {
      return <WorkspaceLoadingSplash />;
    }

    if (user && idToken) {
      return (
        <WorkspaceProvider workspaceId={workspaceId} token="" bearerToken={idToken}>
          <IdentityGate>
            <ArtifactsProvider>
              <LayoutProvider>
                <Wrapper />
              </LayoutProvider>
            </ArtifactsProvider>
          </IdentityGate>
        </WorkspaceProvider>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8 bg-background">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-semibold">Sign in to access this workspace</h1>
          <p className="text-muted-foreground text-sm text-center max-w-md">
            Log in with your 52hzAgents account to access workspaces you own, or add a token to the URL.
          </p>
        </div>
        <button
          onClick={signIn}
          className="flex items-center gap-3 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors cursor-pointer"
        >
          <span>Sign in with Google</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 bg-background">
      <h1 className="text-xl font-semibold text-destructive">Missing Token</h1>
      <p className="text-muted-foreground text-sm">
        Add <code className="bg-muted px-2 py-0.5 rounded">?token=your_workspace_token</code> to the URL.
      </p>
    </div>
  );
}

export function WorkspaceClient({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId: initialWorkspaceId } = use(params);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);

  useEffect(() => {
    if (typeof window !== 'undefined' && initialWorkspaceId === 'default') {
      const search = new URLSearchParams(window.location.search);
      const wsParam = search.get('workspace') || search.get('ws');
      if (wsParam) {
        setWorkspaceId(wsParam);
        return;
      }
      const segments = window.location.pathname.split('/').filter(Boolean);
      if (segments.length > 0 && segments[0] !== 'default' && segments[0] !== 'share' && segments[0] !== 'quickbar') {
        setWorkspaceId(segments[0]);
      }
    }
  }, [initialWorkspaceId]);

  return (
    <Suspense fallback={<WorkspaceLoadingSplash />}>
      <WorkspaceContent workspaceId={workspaceId} />
    </Suspense>
  );
}
