'use client';

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { ArtifactItem } from '@/lib/artifacts';

export type { ArtifactItem, ArtifactKind, ArtifactGroup } from '@/lib/artifacts';

/*
  WHICH OUTPUT THE OUTPUTS PANEL IS SHOWING.

  The panel lists every output of the current thread (derived from its
  messages -- see lib/artifacts.ts), so this holds only the selection, never a
  copy of the content. What used to live here -- an annotations store that was
  never sent anywhere, an unused history and an edit function with no caller --
  is gone with the review layer it backed.
*/
export type OutputSelection =
  | { kind: 'document'; key: string; versionId?: string }
  | { kind: 'change'; path: string; turnId: string }
  | { kind: 'file' };

interface ArtifactsContextValue {
  selection: OutputSelection | null;
  isCanvasOpen: boolean;
  /** Bumped on every explicit open, so the shell can bring the panel forward. */
  openSeq: number;
  /** Open a document (any version of it) from the transcript. */
  openArtifact: (artifact: ArtifactItem) => void;
  openOutput: (selection: OutputSelection) => void;
  closeCanvas: () => void;
  toggleCanvas: () => void;
}

const ArtifactsContext = createContext<ArtifactsContextValue | null>(null);

export function ArtifactsProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<OutputSelection | null>(null);
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);

  const openOutput = useCallback((next: OutputSelection) => {
    setSelection(next);
    setIsCanvasOpen(true);
    setOpenSeq((n) => n + 1);
  }, []);

  const openArtifact = useCallback(
    (artifact: ArtifactItem) => openOutput({ kind: 'document', key: artifact.key, versionId: artifact.id }),
    [openOutput]
  );

  const closeCanvas = useCallback(() => setIsCanvasOpen(false), []);
  const toggleCanvas = useCallback(() => setIsCanvasOpen((prev) => !prev), []);

  const value = useMemo(
    () => ({ selection, isCanvasOpen, openSeq, openArtifact, openOutput, closeCanvas, toggleCanvas }),
    [selection, isCanvasOpen, openSeq, openArtifact, openOutput, closeCanvas, toggleCanvas]
  );

  return <ArtifactsContext.Provider value={value}>{children}</ArtifactsContext.Provider>;
}

export function useArtifacts() {
  const ctx = useContext(ArtifactsContext);
  if (!ctx) {
    throw new Error('useArtifacts must be used within an ArtifactsProvider');
  }
  return ctx;
}
