import { WebContentsView, BrowserWindow } from 'electron'
import path from 'path'
import { getBackendUrl, onBackendUrlChange } from './backend-config'

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class EmbeddedViewManager {
  private view: WebContentsView | null = null
  private parentWindow: BrowserWindow | null = null
  private currentUrl: string = 'http://localhost:3005'
  private currentBackendUrl: string = ''
  private customBounds: ViewBounds | null = null
  private isVisible: boolean = false
  private onResize: (() => void) | null = null
  private unsubscribeBackendChange: (() => void) | null = null

  constructor() {
    // Subscribe to live backend URL changes
    this.unsubscribeBackendChange = onBackendUrlChange((newBackendUrl) => {
      if (this.view && this.currentBackendUrl !== newBackendUrl) {
        console.log(`[EmbeddedViewManager] Live backend URL changed to ${newBackendUrl}; recreating WebContentsView`)
        const parent = this.parentWindow
        const targetUrl = this.currentUrl
        const bounds = this.customBounds
        const wasVisible = this.isVisible
        this.destroyView()
        if (parent && !parent.isDestroyed() && wasVisible) {
          this.attach(parent, targetUrl)
          this.show(bounds ?? undefined)
        }
      }
    })
  }

  /**
   * Calculates and applies bounds dynamically. Prevents overflow when window is narrow.
   */
  private updateBounds(): void {
    if (!this.view || !this.parentWindow || this.parentWindow.isDestroyed()) return
    const parentBounds = this.parentWindow.getContentBounds()

    if (this.customBounds) {
      // Use caller-specified bounds, clamped to parent window size to prevent overflow
      const clampedWidth = Math.min(this.customBounds.width, Math.max(0, parentBounds.width - this.customBounds.x))
      const clampedHeight = Math.min(this.customBounds.height, Math.max(0, parentBounds.height - this.customBounds.y))
      this.view.setBounds({
        x: this.customBounds.x,
        y: this.customBounds.y,
        width: Math.max(0, clampedWidth),
        height: Math.max(0, clampedHeight),
      })
    } else {
      // Standard layout: x: 240, width fills remaining space without overflow
      const width = Math.max(0, parentBounds.width - 240)
      this.view.setBounds({
        x: 240,
        y: 0,
        width,
        height: parentBounds.height,
      })
    }
  }

  /**
   * Destroys ONLY the WebContentsView instance without resetting parentWindow reference.
   */
  private destroyView(): void {
    this.isVisible = false
    if (this.view) {
      if (this.parentWindow && !this.parentWindow.isDestroyed()) {
        try {
          this.parentWindow.contentView.removeChildView(this.view)
        } catch {}
      }
      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.close()
      }
      this.view = null
    }
    this.currentBackendUrl = ''
  }

  /**
   * Initializes or updates the embedded WebContentsView attached to the parent window.
   */
  public attach(parentWindow: BrowserWindow, targetUrl?: string): WebContentsView {
    const activeBackend = getBackendUrl()
    const urlToLoad = targetUrl || process.env.ELECTRON_FRONTEND_URL || 'http://localhost:3005'
    this.currentUrl = urlToLoad

    // Clean up resize listener on previous window if changed
    if (this.parentWindow && this.parentWindow !== parentWindow && this.onResize && !this.parentWindow.isDestroyed()) {
      this.parentWindow.removeListener('resize', this.onResize)
      this.onResize = null
    }

    this.parentWindow = parentWindow

    // If backend URL changed since initial attach, destroy view ONLY (preserving parentWindow)
    if (this.view && this.currentBackendUrl !== activeBackend) {
      console.log(`[EmbeddedViewManager] Backend URL updated to ${activeBackend}; recreating WebContentsView`)
      this.destroyView()
    }

    if (!this.view) {
      this.currentBackendUrl = activeBackend
      const preloadPath = path.join(__dirname, '../preload/embedded.js')

      this.view = new WebContentsView({
        webPreferences: {
          preload: preloadPath,
          additionalArguments: [`--backend-url=${activeBackend}`],
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })

      this.view.webContents.loadURL(urlToLoad).catch((err) => {
        console.warn('[EmbeddedViewManager] Failed to load URL:', err.message)
      })
    }

    // Attach resize listener to parent window
    if (!this.onResize && this.parentWindow && !this.parentWindow.isDestroyed()) {
      this.onResize = () => this.updateBounds()
      this.parentWindow.on('resize', this.onResize)
    }

    return this.view
  }

  /**
   * Shows the embedded WebContentsView over the specified bounds of the parent window.
   */
  public show(bounds?: ViewBounds | null): void {
    if (!this.view || !this.parentWindow || this.parentWindow.isDestroyed()) return

    this.isVisible = true
    this.customBounds = bounds ?? null

    if (!this.parentWindow.contentView.children.includes(this.view)) {
      this.parentWindow.contentView.addChildView(this.view)
    }

    this.updateBounds()

    // Ensure resize listener is active
    if (!this.onResize && this.parentWindow && !this.parentWindow.isDestroyed()) {
      this.onResize = () => this.updateBounds()
      this.parentWindow.on('resize', this.onResize)
    }
  }

  /**
   * Hides the embedded WebContentsView from the parent window.
   */
  public hide(): void {
    this.isVisible = false
    if (this.view && this.parentWindow && !this.parentWindow.isDestroyed()) {
      try {
        this.parentWindow.contentView.removeChildView(this.view)
      } catch {
        // Ignored if already removed
      }
    }
    if (this.parentWindow && this.onResize && !this.parentWindow.isDestroyed()) {
      this.parentWindow.removeListener('resize', this.onResize)
      this.onResize = null
    }
  }

  /**
   * Reloads the embedded WebContentsView with a new target URL or workspace context.
   */
  public navigate(targetUrl: string): void {
    this.currentUrl = targetUrl
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.loadURL(targetUrl).catch(() => {})
    }
  }

  /**
   * Destroys the view instance cleanly using public Electron APIs.
   */
  public destroy(): void {
    this.hide()
    this.destroyView()
    if (this.unsubscribeBackendChange) {
      this.unsubscribeBackendChange()
      this.unsubscribeBackendChange = null
    }
    this.parentWindow = null
    this.customBounds = null
  }
}

export const embeddedViewManager = new EmbeddedViewManager()
