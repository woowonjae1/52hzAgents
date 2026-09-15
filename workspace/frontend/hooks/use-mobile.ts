import { useEffect, useState } from 'react';
import { getBridge } from '@/lib/desktop';

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkIsMobile = () => {
      // In the desktop Electron shell, never treat the window as a mobile phone.
      // Desktop windows handle narrow widths via ShellFit container queries (auto-collapsing the sidebar).
      if (typeof document !== 'undefined' && (Boolean(getBridge()) || document.documentElement.hasAttribute('data-desktop'))) {
        setIsMobile(false);
        return;
      }
      setIsMobile(window.innerWidth < 1024);
    };

    checkIsMobile();
    window.addEventListener('resize', checkIsMobile);

    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);

  return isMobile;
}
