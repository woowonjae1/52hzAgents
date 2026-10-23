'use client';

import * as React from 'react';
import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useWorkspace } from './workspace-context';

export interface SessionGridContextType {
  isSplit: boolean;
  secondarySessionId: string | null;
  splitRatio: number;
  splitOrientation: 'horizontal' | 'vertical';
  toggleSplit: (targetSessionId?: string) => void;
  openSplitWith: (sessionId: string) => void;
  closeSplit: () => void;
  swapSessions: () => void;
  setSecondarySessionId: (id: string | null) => void;
  setSplitRatio: (ratio: number) => void;
  setSplitOrientation: (orientation: 'horizontal' | 'vertical') => void;
}

const SessionGridContext = createContext<SessionGridContextType | null>(null);

export function SessionGridProvider({ children }: { children: React.ReactNode }) {
  const { currentSessionId, setCurrentSessionId, sessions } = useWorkspace();
  const [isSplit, setIsSplit] = useState(false);
  const [secondarySessionId, setSecondarySessionId] = useState<string | null>(null);
  const [splitRatio, setSplitRatioState] = useState(0.5);
  const [splitOrientation, setSplitOrientation] = useState<'horizontal' | 'vertical'>('horizontal');

  const setSplitRatio = useCallback((ratio: number) => {
    const clamped = Math.max(0.2, Math.min(0.8, ratio));
    setSplitRatioState(clamped);
  }, []);

  const openSplitWith = useCallback((targetId: string) => {
    setSecondarySessionId(targetId);
    setIsSplit(true);
  }, []);

  const toggleSplit = useCallback(
    (explicitTargetId?: string) => {
      setIsSplit((prev) => {
        if (prev) {
          return false;
        }
        // If enabling split, find a suitable secondary session
        if (explicitTargetId) {
          setSecondarySessionId(explicitTargetId);
        } else if (!secondarySessionId || secondarySessionId === currentSessionId) {
          const otherSession = sessions.find((s) => s.sessionId !== currentSessionId);
          if (otherSession) {
            setSecondarySessionId(otherSession.sessionId);
          }
        }
        return true;
      });
    },
    [currentSessionId, secondarySessionId, sessions]
  );

  const closeSplit = useCallback(() => {
    setIsSplit(false);
  }, []);

  const swapSessions = useCallback(() => {
    if (!currentSessionId || !secondarySessionId) return;
    const oldPrimary = currentSessionId;
    const oldSecondary = secondarySessionId;
    setCurrentSessionId(oldSecondary);
    setSecondarySessionId(oldPrimary);
  }, [currentSessionId, secondarySessionId, setCurrentSessionId]);

  const value = useMemo<SessionGridContextType>(
    () => ({
      isSplit,
      secondarySessionId,
      splitRatio,
      splitOrientation,
      toggleSplit,
      openSplitWith,
      closeSplit,
      swapSessions,
      setSecondarySessionId,
      setSplitRatio,
      setSplitOrientation,
    }),
    [
      isSplit,
      secondarySessionId,
      splitRatio,
      splitOrientation,
      toggleSplit,
      openSplitWith,
      closeSplit,
      swapSessions,
      setSplitRatio,
    ]
  );

  return <SessionGridContext.Provider value={value}>{children}</SessionGridContext.Provider>;
}

export function useSessionGrid(): SessionGridContextType {
  const ctx = useContext(SessionGridContext);
  if (!ctx) {
    throw new Error('useSessionGrid must be used within SessionGridProvider');
  }
  return ctx;
}

export function useSessionGridOptional(): SessionGridContextType | null {
  return useContext(SessionGridContext);
}
