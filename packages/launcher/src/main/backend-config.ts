let activeBackendUrl: string = process.env.ELECTRON_BACKEND_URL || 'http://localhost:8000'

type BackendUrlListener = (url: string) => void
const listeners = new Set<BackendUrlListener>()

export function getBackendUrl(): string {
  return activeBackendUrl
}

export function setBackendUrl(url: string): void {
  if (activeBackendUrl === url) return
  activeBackendUrl = url
  listeners.forEach((listener) => {
    try {
      listener(url)
    } catch (err) {
      console.error('[backend-config] Error in backend URL listener:', err)
    }
  })
}

export function onBackendUrlChange(listener: BackendUrlListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
