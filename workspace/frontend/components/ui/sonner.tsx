'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Toaster as Sonner } from 'sonner';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, Loader2 } from 'lucide-react';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      position="top-center"
      offset="18px"
      gap={10}
      duration={3000}
      visibleToasts={3}
      icons={{
        /*
         * Status TOKENS, not palette shades. These were `-400` steps written
         * with no light-theme counterpart — emerald/blue/amber/rose-400 all sit
         * around 1.9:1 against the light toast ground, i.e. the icon that says
         * whether the thing worked was the least legible mark on it in half the
         * app's themes. `--status-*` carries a per-theme value already.
         *
         * `info` is deliberately uncoloured. Success, warning and error each
         * change what the reader should do next; "here is a fact" does not, and
         * a blue disc spends attention to say something the sentence beside it
         * already says.
         */
        success: <CheckCircle2 className="size-4 text-status-success shrink-0 stroke-[2.2]" />,
        info: <Info className="size-4 text-foreground-muted shrink-0 stroke-[2.2]" />,
        warning: <AlertTriangle className="size-4 text-status-warning shrink-0 stroke-[2.2]" />,
        error: <AlertCircle className="size-4 text-status-danger shrink-0 stroke-[2.2]" />,
        loading: <Loader2 className="size-4 text-foreground-muted shrink-0 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          /*
           * `bg-[#16161c]/95` had NO `dark:` prefix, so every toast in the light
           * theme was a near-black pill with `text-foreground` (near-black) on
           * it — the message was legible only because the 95% alpha let the page
           * through. `bg-surface-overlay/95` is the same dark value in the dark
           * theme and white in the light one.
           *
           * The hand-rolled `shadow-[...]` is now `shadow-xl`, which resolves to
           * `--elevation-5` and therefore gets the light theme's hairline ring
           * and the dark theme's lit top edge instead of one recipe pretending
           * to work in both.
           */
          toast:
            'group toast group-[.toaster]:bg-surface-overlay/95 group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-xl group-[.toaster]:backdrop-blur-xl group-[.toaster]:rounded-full group-[.toaster]:px-5 group-[.toaster]:py-2.5 group-[.toaster]:min-h-0 group-[.toaster]:w-auto group-[.toaster]:max-w-lg group-[.toaster]:gap-3 group-[.toaster]:text-[14px] group-[.toaster]:font-medium transition-all duration-200',
          title: 'group-[.toast]:font-medium group-[.toast]:text-[14px] group-[.toast]:leading-snug group-[.toast]:text-foreground group-[.toast]:tracking-normal',
          description: 'group-[.toast]:text-muted-foreground group-[.toast]:text-xs group-[.toast]:leading-normal group-[.toast]:mt-0.5',
          actionButton:
            'group-[.toast]:rounded-full! group-[.toast]:bg-primary group-[.toast]:text-primary-foreground! group-[.toast]:text-xs group-[.toast]:px-3.5 group-[.toast]:py-1.5 group-[.toast]:font-medium group-[.toast]:shadow-sm hover:group-[.toast]:opacity-90',
          cancelButton:
            'group-[.toast]:rounded-full! group-[.toast]:bg-surface3 group-[.toast]:text-foreground! group-[.toast]:text-xs group-[.toast]:px-3.5 group-[.toast]:py-1.5 group-[.toast]:font-medium hover:group-[.toast]:bg-surface4',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
