import { getApiBaseUrl } from './config';

const STORAGE_KEYS = {
  accessToken: 'oa_access_token',
  refreshToken: 'oa_refresh_token',
  userEmail: 'oa_user_email',
  displayName: 'oa_display_name',
} as const;

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userEmail: string | null;
  displayName: string | null;
}

export function getStoredAuth(): AuthState {
  if (typeof window === 'undefined') {
    return { accessToken: null, refreshToken: null, userEmail: null, displayName: null };
  }
  return {
    accessToken: localStorage.getItem(STORAGE_KEYS.accessToken),
    refreshToken: localStorage.getItem(STORAGE_KEYS.refreshToken),
    userEmail: localStorage.getItem(STORAGE_KEYS.userEmail),
    displayName: localStorage.getItem(STORAGE_KEYS.displayName),
  };
}

export function setStoredAuth(auth: Partial<AuthState>): void {
  if (typeof window === 'undefined') return;
  if (auth.accessToken !== undefined) {
    if (auth.accessToken) localStorage.setItem(STORAGE_KEYS.accessToken, auth.accessToken);
    else localStorage.removeItem(STORAGE_KEYS.accessToken);
  }
  if (auth.refreshToken !== undefined) {
    if (auth.refreshToken) localStorage.setItem(STORAGE_KEYS.refreshToken, auth.refreshToken);
    else localStorage.removeItem(STORAGE_KEYS.refreshToken);
  }
  if (auth.userEmail !== undefined) {
    if (auth.userEmail) localStorage.setItem(STORAGE_KEYS.userEmail, auth.userEmail);
    else localStorage.removeItem(STORAGE_KEYS.userEmail);
  }
  if (auth.displayName !== undefined) {
    if (auth.displayName) localStorage.setItem(STORAGE_KEYS.displayName, auth.displayName);
    else localStorage.removeItem(STORAGE_KEYS.displayName);
  }
}

export function storeAuth(data: {
  access_token: string;
  refresh_token: string;
  user: { email: string; display_name: string };
}) {
  setStoredAuth({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    userEmail: data.user?.email,
    displayName: data.user?.display_name,
  });
}

export function clearAuth() {
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
}

export async function loginWithEmail(email: string, password: string): Promise<AuthState> {
  const res = await fetch(`${getApiBaseUrl()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed: ${text}`);
  }
  const data = await res.json();
  const state: AuthState = {
    accessToken: data.access_token || null,
    refreshToken: data.refresh_token || null,
    userEmail: data.user?.email || email,
    displayName: data.user?.name || null,
  };
  setStoredAuth(state);
  return state;
}

export const login = loginWithEmail;

export async function refreshAccessToken(): Promise<string | null> {
  const current = getStoredAuth();
  if (!current.refreshToken) return null;
  try {
    const res = await fetch(`${getApiBaseUrl()}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    });
    if (!res.ok) {
      clearAuth();
      return null;
    }
    const json = await res.json();
    const newAccessToken = json.data.access_token;
    setStoredAuth({ accessToken: newAccessToken });
    return newAccessToken;
  } catch {
    return null;
  }
}
