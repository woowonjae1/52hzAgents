/**
 * Dynamic API Base URL Getter.
 * Resolution priority:
 * 1. window.electronBridge.getApiUrl() (Desktop Electron environment - Synchronous)
 * 2. window.__APP_CONFIG__?.apiUrl (Runtime window config override)
 * 3. process.env.NEXT_PUBLIC_API_URL (Build-time environment variable)
 * 4. Standard Fallback: 'http://localhost:8000' (Eliminates inconsistent openagents.org vs localhost fallbacks)
 */

interface ElectronBridge {
  getApiUrl?: () => string;
  getWorkspaceToken?: (slug: string) => Promise<string | null>;
  isDesktop?: boolean;
}

let cachedApiBaseUrl: string | null = null;

export function getApiBaseUrl(): string {
  if (cachedApiBaseUrl) return cachedApiBaseUrl;

  if (typeof window !== 'undefined') {
    const bridge = (window as unknown as { electronBridge?: ElectronBridge }).electronBridge;
    if (bridge?.getApiUrl) {
      try {
        const desktopUrl = bridge.getApiUrl();
        if (desktopUrl && typeof desktopUrl === 'string') {
          cachedApiBaseUrl = desktopUrl;
          return desktopUrl;
        }
      } catch (e) {
        console.warn('[config] getApiUrl failed:', e);
      }
    }
    const globalConfig = (window as unknown as { __APP_CONFIG__?: { apiUrl?: string } }).__APP_CONFIG__;
    if (globalConfig?.apiUrl) {
      cachedApiBaseUrl = globalConfig.apiUrl;
      return globalConfig.apiUrl;
    }
    if (window.location && window.location.origin && window.location.origin.startsWith('http')) {
      cachedApiBaseUrl = window.location.origin;
      return window.location.origin;
    }
  }
  const fallback = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
  cachedApiBaseUrl = fallback;
  return fallback;
}

export function resetCachedApiBaseUrl(): void {
  cachedApiBaseUrl = null;
}
