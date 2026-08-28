import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/lib/auth-context';
import { OpenAgentsAuthProvider } from '@/lib/openagents-auth-context';
import { MARK_COLOR_PREPAINT_SCRIPT } from '@/lib/mark-color-store';

/*
 * Type faces. These are the ONLY thing that puts `Inter Variable` and
 * `JetBrains Mono Variable` — the first entry of `--font-sans` / `--font-mono`
 * in globals.css — on the page. Delete an import and that family silently stops
 * resolving; the stack falls through to the system face with no error anywhere.
 *
 * Self-hosted rather than `next/font/google` on purpose: `output: 'export'`
 * plus the offline desktop shell means there is no request to fonts.gstatic.com
 * to make. Webpack emits the .woff2 files into the static output, so a build
 * needs no network and neither does a run. (This is what the previous
 * `next/font` setup was removed for — the removal just took the faces with it
 * instead of replacing them.)
 *
 * `opsz` rather than the default `index.css` (`wght` only): see the
 * `font-optical-sizing` note in globals.css. The `-italic` halves are separate
 * files that the browser fetches only when italic text is actually rendered —
 * markdown emphasis in an agent reply — so they cost build size, not load time.
 * Without them Chrome synthesises a slanted oblique, which on a mono face in
 * particular looks like a rendering bug.
 *
 * Every face is subsetted by `unicode-range` (latin, latin-ext, greek,
 * cyrillic, vietnamese). Only the subsets a page actually uses are downloaded.
 * No CJK face is imported at all — Han comes from the platform's UI font, per
 * the `--font-sans` comment.
 */
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/jetbrains-mono/wght-italic.css';
import '@/styles/globals.css';

// Analytics identifiers are injected via Vercel env vars (Project → Settings →
// Environment Variables) rather than hardcoded. NEXT_PUBLIC_* values are inlined
// into the client bundle at build time. When a key is unset the corresponding
// snippet is skipped entirely, so analytics simply no-ops (e.g. local dev or
// preview deploys without the vars configured).
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://d.openagents.org';
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

export const metadata: Metadata = {
  title: '52hzAgents Workspace',
  description: 'Interact with your AI agents in real time in a high-concurrency multi-agent collaboration space',
  icons: {
    icon: [
      { url: '/logo-icon.png', sizes: 'any' },
      { url: '/logo-icon.png', sizes: '16x16', type: 'image/png' },
      { url: '/logo-icon.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/logo-icon.png',
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // No font class on <html>: the families are plain `@font-face` names now, so
  // `font-sans` / `font-mono` resolve them from anywhere in the document —
  // including Radix popovers and the Sonner toaster, which portal outside the
  // body tree. The two classes that used to sit here (`font-sans-fallback`,
  // `font-mono-fallback`) matched no rule in any stylesheet.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Blocking and inline on purpose — `next/script` would defer this past
            first paint, which is the one thing it must beat. See
            MARK_COLOR_PREPAINT_SCRIPT. */}
        <script dangerouslySetInnerHTML={{ __html: MARK_COLOR_PREPAINT_SCRIPT }} />
        {POSTHOG_KEY && (
        <Script id="posthog-init" strategy="afterInteractive">{`
          !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
          posthog.init('${POSTHOG_KEY}', {
            api_host: '${POSTHOG_HOST}',
            person_profiles: 'identified_only',
            capture_pageview: true,
            capture_pageleave: true,
            autocapture: true
          });
        `}</Script>
        )}
        {GA_ID && (
        <>
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}</Script>
        </>
        )}
      </head>
      <body className="bg-background text-foreground font-sans">
        {/* Dark is the signature theme — the neutral ramp and the inverted
            (light-fill/dark-text) buttons are designed on a dark ground, so
            `defaultTheme` lands a first visit there and `enableSystem` is
            dropped rather than inheriting the OS preference. There is no
            `forcedTheme`: it pins the class and silently turns every
            `setTheme()` into a no-op, which is what broke the light/dark
            toggle — pass `defaultTheme` alone to pick a default the user can
            still override. */}
        <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
          <AuthProvider>
            <OpenAgentsAuthProvider>
              {children}
            </OpenAgentsAuthProvider>
          </AuthProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
