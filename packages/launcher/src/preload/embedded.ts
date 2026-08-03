import { contextBridge, ipcRenderer } from 'electron'

/**
 * Embedded View Preload (Minimal Sandbox Bridge).
 * 
 * SECURITY CRITICAL: Dedicated for untrusted/embedded Web views.
 * Exposes ONLY safe synchronous getters and explicit token resolvers.
 * NEVER exposes sensitive capabilities like shellExec or revealCredential.
 */

// Parse backend URL passed down from Main Process via webPreferences.additionalArguments
const backendUrlArg = process.argv.find((arg) => arg.startsWith('--backend-url='))
const desktopBackendUrl = backendUrlArg ? backendUrlArg.split('=')[1] : 'http://localhost:8000'

contextBridge.exposeInMainWorld('electronBridge', {
  getApiUrl: (): string => desktopBackendUrl,
  getWorkspaceToken: (slug?: string): Promise<string | null> => {
    if (!slug) {
      console.warn('[electronBridge] getWorkspaceToken requires an explicit workspace slug.')
      return Promise.resolve(null)
    }
    return ipcRenderer.invoke('workspace:get-token', slug)
  },
  isDesktop: true,
})
