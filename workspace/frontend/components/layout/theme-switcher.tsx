'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PASEO_THEMES,
  applyPaseoTint,
  getPaseoTheme,
  resolvePaseoTheme,
  storePaseoTheme,
  type PaseoThemeName,
} from '@/lib/paseo-theme';

/**
 * Paseo's theme picker: one row of swatches for light plus the five dark tints.
 *
 * `next-themes` owns the light/dark class; this only adds the tint on top, so
 * selecting a dark tint also flips next-themes into dark mode.
 */
export function ThemeSwitcher({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [selected, setSelected] = useState<PaseoThemeName>('light');

  useEffect(() => {
    setMounted(true);
  }, []);

  // Re-derive whenever light/dark changes so the light toggle and the tint stay
  // consistent: leaving dark mode drops the tint, returning restores it.
  useEffect(() => {
    if (!mounted) return;
    const next = resolvePaseoTheme(resolvedTheme === 'dark');
    setSelected(next);
    applyPaseoTint(next);
  }, [mounted, resolvedTheme]);

  const select = (name: PaseoThemeName) => {
    const info = getPaseoTheme(name);
    setSelected(name);
    storePaseoTheme(name);
    applyPaseoTint(name);
    setTheme(info.isDark ? 'dark' : 'light');
  };

  if (!mounted) return null;

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {PASEO_THEMES.map((themeInfo) => {
        const isSelected = themeInfo.name === selected;
        return (
          <button
            key={themeInfo.name}
            type="button"
            onClick={() => select(themeInfo.name)}
            title={themeInfo.label}
            aria-label={`${themeInfo.label} theme`}
            aria-pressed={isSelected}
            className={cn(
              'relative size-5 shrink-0 rounded-full border transition-all cursor-pointer',
              isSelected
                ? 'border-accent-bright ring-2 ring-accent/30 scale-110'
                : 'border-border hover:border-border-accent hover:scale-105',
            )}
            style={{ backgroundColor: themeInfo.swatch }}
          >
            {isSelected && (
              <Check
                className={cn(
                  'absolute inset-0 m-auto size-3',
                  // Fixed colours, not tokens: the check sits on the swatch, whose
                  // colour is the same in every theme. `text-foreground` here would
                  // flip to near-white in dark mode and vanish on the white swatch.
                  themeInfo.name === 'light' ? 'text-foreground' : 'text-white',
                )}
                strokeWidth={3}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
