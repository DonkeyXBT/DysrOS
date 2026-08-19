import { contextBridge, ipcRenderer } from 'electron'

/**
 * The entire surface the renderer can reach. Nothing else is exposed: no
 * filesystem, no database handle, no direct network.
 */
const api = {
  summary: () => ipcRenderer.invoke('summary'),
  shipments: () => ipcRenderer.invoke('shipments'),
  dashboard: () => ipcRenderer.invoke('dashboard'),
  inventory: () => ipcRenderer.invoke('inventory'),
  productImage: (url: string) => ipcRenderer.invoke('product-image', url),
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
  onUpdateAvailable: (handler: (info: { version: string }) => void) => {
    const listener = (_e: unknown, info: { version: string }) => handler(info)
    ipcRenderer.on('update-available', listener)
    return () => ipcRenderer.removeListener('update-available', listener)
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
  logEntries: () => ipcRenderer.invoke('log-entries'),
  logPath: () => ipcRenderer.invoke('log-path'),
  logClear: () => ipcRenderer.invoke('log-clear'),
  logOpenFolder: () => ipcRenderer.invoke('log-open-folder'),
  crashReportUrl: (index: number) => ipcRenderer.invoke('crash-report-url', index),
  reportRendererError: (message: string, detail: string) =>
    ipcRenderer.invoke('report-renderer-error', message, detail),
  onSyncProgress: (handler: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => handler(p)
    ipcRenderer.on('sync-progress', listener)
    return () => ipcRenderer.removeListener('sync-progress', listener)
  },
  onCrash: (handler: (entry: unknown) => void) => {
    const listener = (_e: unknown, entry: unknown) => handler(entry)
    ipcRenderer.on('crash', listener)
    return () => ipcRenderer.removeListener('crash', listener)
  },
  deleteAllData: (includeAccounts: boolean) =>
    ipcRenderer.invoke('delete-all-data', includeAccounts),
  deleteRecord: (kind: string, id: string) => ipcRenderer.invoke('delete-record', kind, id),
  discordSettings: () => ipcRenderer.invoke('discord-settings'),
  discordSetWebhook: (url: string) => ipcRenderer.invoke('discord-set-webhook', url),
  discordSetRule: (event: string, enabled: boolean) =>
    ipcRenderer.invoke('discord-set-rule', event, enabled),
  discordTest: () => ipcRenderer.invoke('discord-test'),
  reparseAll: () => ipcRenderer.invoke('reparse-all'),
  resolveTracking: () => ipcRenderer.invoke('resolve-tracking'),
  exportMessage: (id: string, format: 'eml' | 'html') =>
    ipcRenderer.invoke('export-message', id, format),
  exportAllUnrecognised: () => ipcRenderer.invoke('export-all-unrecognised'),
  aycdStatus: () => ipcRenderer.invoke('aycd-status'),
  aycdSetKey: (key: string) => ipcRenderer.invoke('aycd-set-key', key),
  aycdClearKey: () => ipcRenderer.invoke('aycd-clear-key'),
  aycdSetAddresses: (addresses: string[]) => ipcRenderer.invoke('aycd-set-addresses', addresses),
  aycdVerify: () => ipcRenderer.invoke('aycd-verify'),
  aycdStart: () => ipcRenderer.invoke('aycd-start'),
  aycdStop: () => ipcRenderer.invoke('aycd-stop'),
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
