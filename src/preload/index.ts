import { contextBridge, ipcRenderer } from 'electron'

/**
 * The entire surface the renderer can reach. Nothing else is exposed: no
 * filesystem, no database handle, no direct network.
 */
const api = {
  summary: () => ipcRenderer.invoke('summary'),
  shipments: () => ipcRenderer.invoke('shipments'),
  purchases: () => ipcRenderer.invoke('purchases'),
  cancellations: () => ipcRenderer.invoke('cancellations'),
  review: () => ipcRenderer.invoke('review'),
  parsers: () => ipcRenderer.invoke('parsers'),
  providers: () => ipcRenderer.invoke('providers'),
  importEml: () => ipcRenderer.invoke('import-eml'),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window-toggle-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  windowState: () => ipcRenderer.invoke('window-state'),
  onWindowState: (handler: (state: { maximized: boolean; fullScreen: boolean }) => void) => {
    const listener = (_e: unknown, state: { maximized: boolean; fullScreen: boolean }) => handler(state)
    ipcRenderer.on('window-state', listener)
    return () => ipcRenderer.removeListener('window-state', listener)
  },
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateProgress: (handler: (p: { percent: number; bytesPerSecond: number }) => void) => {
    const listener = (_e: unknown, p: { percent: number; bytesPerSecond: number }) => handler(p)
    ipcRenderer.on('update-progress', listener)
    return () => ipcRenderer.removeListener('update-progress', listener)
  },
  onUpdateDownloaded: (handler: (info: { version: string }) => void) => {
    const listener = (_e: unknown, info: { version: string }) => handler(info)
    ipcRenderer.on('update-downloaded', listener)
    return () => ipcRenderer.removeListener('update-downloaded', listener)
  },
  accounts: () => ipcRenderer.invoke('accounts'),
  addAccount: (account: unknown) => ipcRenderer.invoke('add-account', account),
  removeAccount: (id: string) => ipcRenderer.invoke('remove-account', id),
  testAccount: (connection: unknown) => ipcRenderer.invoke('test-account', connection),
  syncAccounts: () => ipcRenderer.invoke('sync-accounts'),
  encryptionAvailable: () => ipcRenderer.invoke('encryption-available'),
  mailDir: () => ipcRenderer.invoke('mail-dir'),
  rescan: () => ipcRenderer.invoke('rescan'),
  openMailDir: () => ipcRenderer.invoke('open-mail-dir'),
  chooseMailDir: () => ipcRenderer.invoke('choose-mail-dir'),
  onMailUpdated: (handler: () => void) => {
    ipcRenderer.on('mail-updated', handler)
    return () => ipcRenderer.removeListener('mail-updated', handler)
  },
  exportRedirectCsv: () => ipcRenderer.invoke('export-redirect-csv'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
