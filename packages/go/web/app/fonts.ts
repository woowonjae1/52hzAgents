/**
 * Font pipeline for the Go web shell.
 *
 * Kept deliberately identical to `workspace/frontend/app/fonts.ts` — the two
 * surfaces ship under one product and previously disagreed, with this one on a
 * Latin-only Inter and the workspace on nothing at all.
 *
 * `next/font/google` downloads and self-hosts both faces at build time, so
 * nothing is requested from Google at runtime.
 */
import { Inter, JetBrains_Mono } from 'next/font/google';

/**
 * UI face. No `weight` is passed, which pulls the variable weight axis so
 * 400/500/600 resolve to real instances rather than synthesised bold.
 */
export const fontSans = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/** Monospace face for code blocks, slugs, commands and terminal output. */
export const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});
