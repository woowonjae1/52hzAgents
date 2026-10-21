'use client';

import { useState, useEffect, Suspense } from 'react';
import { WorkspaceContent, WorkspaceLoadingSplash } from './[workspaceId]/workspace-client';
import { ShareClient } from './share/[token]/share-client';

function getInitialClientRoute(): { type: 'share'; token: string } | { type: 'workspace'; slug: string } {
  if (typeof window === 'undefined') return { type: 'workspace', slug: '52hz' };
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const search = new URLSearchParams(window.location.search);

  // 1. Share route: /share/:token
  if (pathname.startsWith('/share/')) {
    const token = pathname.replace(/^\/share\//, '').split('/')[0];
    if (token) return { type: 'share', token };
  }

  // 2. Query param ?workspace=:slug or ?ws=:slug
  const querySlug = search.get('workspace') || search.get('ws');
  if (querySlug) {
    return { type: 'workspace', slug: querySlug };
  }

  // 3. Direct path slug: /:slug
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1 && !['share', 'quickbar', 'api', '_next', 'default'].includes(segments[0])) {
    return { type: 'workspace', slug: segments[0] };
  }

  const saved = localStorage.getItem('last_workspace_slug') || '52hz';
  return { type: 'workspace', slug: saved };
}

export default function HomePage() {
  const [routeInfo, setRouteInfo] = useState(() => getInitialClientRoute());

  useEffect(() => {
    setRouteInfo(getInitialClientRoute());
  }, []);

  // Render share route if landed here via SPA fallback
  if (routeInfo.type === 'share') {
    return <ShareClient params={Promise.resolve({ token: routeInfo.token })} />;
  }

  return (
    <Suspense fallback={<WorkspaceLoadingSplash />}>
      <WorkspaceContent workspaceId={routeInfo.slug} />
    </Suspense>
  );
}
