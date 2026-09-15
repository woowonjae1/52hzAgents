import { useEffect, useState } from 'react';

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkIsMobile = () => {
      if (typeof window !== 'undefined' && ((window as unknown as { electronBridge?: unknown }).electronBridge || (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-desktop')))) {
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
