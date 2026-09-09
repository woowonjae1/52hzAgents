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
        success: <CheckCircle2 className="size-4 text-emerald-400 shrink-0 stroke-[2.2]" />,
        info: <Info className="size-4 text-blue-400 shrink-0 stroke-[2.2]" />,
        warning: <AlertTriangle className="size-4 text-amber-400 shrink-0 stroke-[2.2]" />,
        error: <AlertCircle className="size-4 text-rose-400 shrink-0 stroke-[2.2]" />,
        loading: <Loader2 className="size-4 text-foreground-muted shrink-0 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-[#16161c]/95 group-[.toaster]:dark:bg-[#141419]/95 group-[.toaster]:text-foreground group-[.toaster]:border-border/80 group-[.toaster]:dark:border-white/15 group-[.toaster]:shadow-[0_12px_36px_rgba(0,0,0,0.45),0_0_0_1px_rgba(255,255,255,0.08)] group-[.toaster]:backdrop-blur-2xl group-[.toaster]:rounded-full group-[.toaster]:px-5 group-[.toaster]:py-2.5 group-[.toaster]:min-h-0 group-[.toaster]:w-auto group-[.toaster]:max-w-lg group-[.toaster]:gap-3 group-[.toaster]:text-[14px] group-[.toaster]:font-medium transition-all duration-200',
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
