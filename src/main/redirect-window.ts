import { BrowserWindow } from 'electron'
import type { Page } from '../core/tracking/redirect.js'

/**
 * A real browser page for the redirect driver.
 *
 * Electron is Chromium, so DHL's page can be driven directly — no second
 * browser to install, nothing downloaded at runtime, and it works the same in
 * a packaged build as it does here.
 *
 * The window is its own session partition, kept between parcels: the consent
 * banner is then answered once rather than for every parcel, exactly as it
 * behaves for a person doing several by hand.
 */

/** Chrome's own string. Electron's default names itself, and sites treat that
 *  as a bot; this is a person driving their own parcel. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export interface RedirectWindowOptions {
  /** Shown so the user can watch, and step in if DHL asks something new. */
  show?: boolean
}

export class RedirectWindow implements Page {
  private window: BrowserWindow | null = null

  constructor(private readonly options: RedirectWindowOptions = {}) {}

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window

    this.window = new BrowserWindow({
      width: 1100,
      height: 860,
      show: this.options.show ?? false,
      title: 'DHL — redirecting a parcel',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:dhl-redirect',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A hidden window must keep running at full speed, or every wait in
        // the driver takes far longer than it should.
        backgroundThrottling: false,
      },
    })
    this.window.webContents.setUserAgent(USER_AGENT)
    this.window.on('closed', () => { this.window = null })
    return this.window
  }

  async goto(url: string): Promise<void> {
    const window = this.ensure()
    await window.loadURL(url, { userAgent: USER_AGENT })
  }

  async evaluate<T>(script: string): Promise<T> {
    const window = this.ensure()
    // userGesture: DHL's controls are ordinary buttons, but some of them open
    // dialogs that Chromium blocks without one.
    return window.webContents.executeJavaScript(script, true) as Promise<T>
  }

  /** Brings the window forward, for when someone wants to see what happened. */
  reveal(): void {
    if (this.window && !this.window.isDestroyed()) this.window.show()
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }
}
