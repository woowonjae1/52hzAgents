'use client';

import * as React from 'react';
import type { WorkspaceFile } from '@/lib/types';

/**
 * SORTING A FILE LIST.
 *
 * Files were always newest-first, with no way to change it. Every file
 * manager ever written sorts by name, size or date on demand, and the absence
 * of that is one of the plainer tells that a list of files is a feed rather
 * than a directory. (The whole app had exactly one sort control, in Knowledge.)
 *
 * The order is remembered, because a sort you have to re-pick every time you
 * open the panel is barely a sort.
 */

export type FileSortKey = 'name' | 'size' | 'date';
export type SortDirection = 'asc' | 'desc';

export interface FileSort {
  key: FileSortKey;
  direction: SortDirection;
}

/** Sensible default per column, matching what a file manager does. */
const DEFAULT_DIRECTION: Record<FileSortKey, SortDirection> = {
  name: 'asc',
  size: 'desc',
  date: 'desc',
};

export const SORT_LABELS: Record<FileSortKey, string> = {
  name: 'Name',
  size: 'Size',
  date: 'Date',
};

function leaf(filename: string): string {
  return filename.split(/[\/]/).pop() || filename;
}

export function sortFiles<T extends WorkspaceFile>(list: T[], sort: FileSort): T[] {
  const factor = sort.direction === 'asc' ? 1 : -1;
  // A copy: the caller's array is usually memoised upstream, and sorting in
  // place mutates it under whoever else is reading it.
  return [...list].sort((a, b) => {
    switch (sort.key) {
      case 'name':
        // `localeCompare` with `numeric` so file-2 sorts before file-10, which
        // plain string order gets backwards and everyone notices.
        return factor * leaf(a.filename).localeCompare(leaf(b.filename), undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      case 'size':
        return factor * ((a.size || 0) - (b.size || 0));
      case 'date':
      default: {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return factor * (at - bt);
      }
    }
  });
}

export function useFileSort(storageKey = 'files_sort') {
  const [sort, setSortState] = React.useState<FileSort>(() => {
    if (typeof window === 'undefined') return { key: 'date', direction: 'desc' };
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && SORT_LABELS[parsed.key as FileSortKey]) {
        return { key: parsed.key, direction: parsed.direction === 'asc' ? 'asc' : 'desc' };
      }
    } catch {}
    return { key: 'date', direction: 'desc' };
  });

  const setSort = React.useCallback(
    (next: FileSort) => {
      setSortState(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {}
    },
    [storageKey],
  );

  /**
   * Clicking the column you are already sorted by flips the direction;
   * clicking a different one switches to it at that column's natural default
   * rather than inheriting the previous column's. Sorting by name and then by
   * size should give you biggest-first, not A-Z's ascending carried over.
   */
  const toggle = React.useCallback(
    (key: FileSortKey) => {
      setSort(
        sort.key === key
          ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: DEFAULT_DIRECTION[key] },
      );
    },
    [sort, setSort],
  );

  return { sort, setSort, toggle };
}
