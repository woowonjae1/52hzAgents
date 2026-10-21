'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';

interface OpenAgentsUser {
  email: string;
  displayName: string;
  photoURL: string | null;
}

interface OpenAgentsAuthContextValue {
  user: OpenAgentsUser | null;
  idToken: string | null;
  loading: boolean;
  isOpenAgentsDomain: boolean;
  isAuthConfigured: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const OpenAgentsAuthContext = createContext<OpenAgentsAuthContextValue | null>(null);

export function useOpenAgentsAuth() {
  const ctx = useContext(OpenAgentsAuthContext);
  if (!ctx) throw new Error('useOpenAgentsAuth must be used within OpenAgentsAuthProvider');
  return ctx;
}

export function OpenAgentsAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<OpenAgentsUser | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const loading = false;
  const isOpenAgentsDomain = false;
  const isAuthConfigured = false;

  const signIn = useCallback(async () => {
    // Local-first standalone architecture uses local workspace authentication
  }, []);

  const signOut = useCallback(async () => {
    setUser(null);
    setIdToken(null);
  }, []);

  return (
    <OpenAgentsAuthContext.Provider value={{ user, idToken, loading, isOpenAgentsDomain, isAuthConfigured, signIn, signOut }}>
      {children}
    </OpenAgentsAuthContext.Provider>
  );
}
