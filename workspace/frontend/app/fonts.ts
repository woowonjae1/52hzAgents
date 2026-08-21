/**
 * Font pipeline for the workspace shell.
 *
 * Both faces are pulled through `next/font/google`, which downloads and
 * self-hosts them at build time — nothing is fetched from Google at runtime.
 * That matters twice over here: `next.config.mjs` sets `output: 'export'`, and
 * the same bundle ships inside the desktop app, which has to render correctly
 * with no network at all.
 *
 * Each face is exposed as a CSS variable rather than a class so `globals.css`
 * can compose it with the CJK fallbacks (see `--font-sans` / `--font-mono` in
 * the `@theme` block). Setting `.className` on `<body>` instead would pin the
 * family to the Latin face alone and leave CJK glyphs to browser default.
 */
import { Inter, JetBrains_Mono } from 'next/font/google';

/**
 * UI face. Inter's x-height is unusually tall for its cap height, which is the
 * property that actually decides whether the 10-11px labels this app is built
 * on stay readable — the previous `system-ui` default handed that decision to
 * Segoe UI on Windows and SF Pro on macOS, so the same panel read at two
 * different densities depending on who opened it.
 *
 * No `weight` is passed: that pulls the variable weight axis, so 400/500/600
 * all resolve to real instances instead of synthesised bold.
 */
export const fontSans = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/**
 * Monospace face, carrying agent logs, tool output, workspace slugs and code
 * blocks — 122 `font-mono` sites at last count. JetBrains Mono is chosen over
 * the platform defaults (SF Mono / Consolas / Menlo) for the same reason as
 * above: it holds a taller x-height at the 10-13px these sites use, and it is
 * one face everywhere rather than three that disagree on advance width.
 */
export const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});
