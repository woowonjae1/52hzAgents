'use client';

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

export interface ArtifactAnnotation {
  id: string;
  authorAgent: string; // e.g. "claude", "antigravity"
  title?: string;
  type: 'comment' | 'suggestion' | 'diff' | 'review';
  paragraphIndex?: number;
  content: string;
  suggestedText?: string;
  createdAt: number;
}

export interface ArtifactItem {
  id: string;
  title: string;
  type: 'markdown' | 'code' | 'deliverable' | 'diff';
  language?: string;
  content: string;
  authorAgent?: string;
  filePath?: string;
  updatedAt: number;
  sourceMessageId?: string;
  annotations?: ArtifactAnnotation[];
  version?: number;
}

interface ArtifactsContextValue {
  activeArtifact: ArtifactItem | null;
  isCanvasOpen: boolean;
  artifactsHistory: ArtifactItem[];
  openArtifact: (artifact: ArtifactItem) => void;
  closeCanvas: () => void;
  toggleCanvas: () => void;
  addAnnotation: (artifactId: string, annotation: Omit<ArtifactAnnotation, 'id' | 'createdAt'>) => void;
  updateArtifactContent: (artifactId: string, newContent: string) => void;
}

const ArtifactsContext = createContext<ArtifactsContextValue | null>(null);

export function ArtifactsProvider({ children }: { children: React.ReactNode }) {
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem | null>(null);
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [artifactsHistory, setArtifactsHistory] = useState<ArtifactItem[]>([]);

  const openArtifact = useCallback((artifact: ArtifactItem) => {
    setActiveArtifact(artifact);
    setIsCanvasOpen(true);
    setArtifactsHistory((prev) => {
      const idx = prev.findIndex((a) => a.id === artifact.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = artifact;
        return next;
      }
      return [artifact, ...prev];
    });
  }, []);

  const closeCanvas = useCallback(() => {
    setIsCanvasOpen(false);
  }, []);

  const toggleCanvas = useCallback(() => {
    setIsCanvasOpen((prev) => !prev);
  }, []);

  const addAnnotation = useCallback((artifactId: string, ann: Omit<ArtifactAnnotation, 'id' | 'createdAt'>) => {
    const fullAnn: ArtifactAnnotation = {
      ...ann,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
    };

    setActiveArtifact((prev) => {
      if (!prev || prev.id !== artifactId) return prev;
      return {
        ...prev,
        annotations: [...(prev.annotations || []), fullAnn],
      };
    });

    setArtifactsHistory((prevList) =>
      prevList.map((item) =>
        item.id === artifactId
          ? { ...item, annotations: [...(item.annotations || []), fullAnn] }
          : item
      )
    );
  }, []);

  const updateArtifactContent = useCallback((artifactId: string, newContent: string) => {
    setActiveArtifact((prev) => {
      if (!prev || prev.id !== artifactId) return prev;
      return {
        ...prev,
        content: newContent,
        updatedAt: Date.now(),
        version: (prev.version || 1) + 1,
      };
    });
  }, []);

  const value = useMemo(
    () => ({
      activeArtifact,
      isCanvasOpen,
      artifactsHistory,
      openArtifact,
      closeCanvas,
      toggleCanvas,
      addAnnotation,
      updateArtifactContent,
    }),
    [activeArtifact, isCanvasOpen, artifactsHistory, openArtifact, closeCanvas, toggleCanvas, addAnnotation, updateArtifactContent]
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
