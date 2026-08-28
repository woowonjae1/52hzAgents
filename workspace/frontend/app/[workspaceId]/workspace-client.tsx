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

export function WorkspaceLoadingSplash() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5 animate-[pulse_2s_ease-in-out_infinite]">
        <div className="size-16 flex items-center justify-center rounded-xl border border-border/20 bg-surface1 p-2 shadow-md">
          <SignalMark size={48} />
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight">Workspace</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Loading...</p>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted overflow-hidden">
        <div className="h-full w-1/3 bg-primary rounded-full animate-[loading-bar_1.5s_ease-in-out_infinite]" />
      </div>
      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(150%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

function setWorkspaceCookie(slug: string, token: string) {
  const maxAge = 30 * 24 * 60 * 60;
  const shared = `path=/;max-age=${maxAge};secure;samesite=lax;domain=.openagents.org`;
  document.cookie = `oa_workspace=${encodeURIComponent(JSON.stringify({ slug, token }))};${shared}`;
  document.cookie = `oa_has_workspace=1;${shared}`;
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

  const [mounted, setMounted] = useState(() => typeof window !== 'undefined');
  const [cachedToken, setCachedToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined' && !token) {
      try {
        return localStorage.getItem(`workspace_token_${workspaceId}`) || localStorage.getItem('workspace_token') || '';
      } catch {}
    }
    return null;
  });

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
  const { workspaceId } = use(params);

  return (
    <Suspense fallback={<WorkspaceLoadingSplash />}>
      <WorkspaceContent workspaceId={workspaceId} />
    </Suspense>
  );
}
