export interface ShipmentView {
  id: string; direction: string; carrier: string
  trackingNumber: string | null; trackingUrl: string | null
  linked: string; title: string | null; quantity: number; status: string
  lastMovementAt: string | null; expectedDeliveryAt: string | null
  postalCode: string | null; city: string | null; dhlRedirectable: boolean
  linkedToPurchase: boolean
}
export interface PurchaseView {
  id: string; kind: 'buy' | 'cancel'; retailer: string; reference: string | null; orderedAt: string
  title: string | null; quantity: number; unit: string; shipping: string
  total: string; totalMinor: number; totalsConsistent: boolean; status: string
  refundOutstanding: string | null
}
export interface CancellationView {
  id: string; retailer: string; reference: string | null
  occurredAt: string; title: string | null; refundExpected: boolean
}
export interface ReviewView {
  id: string; from: string; address: string
  subject: string; receivedAt: string; preview: string
  exportable: boolean
}
export interface ParserView { id: string; retailer: string; parsed: number }
export interface ProviderView {
  id: string; label: string; host: string; port: number
  requiresAppPassword: boolean; setupNote: string | null
}
export interface AccountView {
  id: string; label: string; email: string; provider: string
  host: string; port: number; useTls: boolean; username: string
  enabled: boolean; lastSyncAt: string | null; lastError: string | null
}

export interface NewAccountInput {
  label: string; email: string; provider: string
  host: string; port: number; useTls: boolean
  username: string; password: string
}

export interface SyncProgress {
  account: string
  done: number
  stored: number
  subject: string
}

export interface LogEntryView {
  at: string
  level: 'error' | 'warn' | 'info'
  source: string
  message: string
  detail: string | null
}

export interface DiscordSettingsView {
  configured: boolean
  masked: string
  rules: { event: string; label: string; enabled: boolean }[]
}

export interface AycdStatusView {
  configured: boolean
  running: boolean
  addresses: string[]
  templates: number
  activeTasks: number
  registered: number
  succeeded: number
  timedOut: number
  errored: number
  events: number
  lastPollAt: string | null
  lastError: string | null
}

export interface SummaryView {
  messageCount: number; eventCount: number; purchaseCount: number; spend: string
  inbound: number; outbound: number; reviewCount: number
  awaitingTracking: number; redirectable: number
}

interface Api {
  summary(): Promise<SummaryView>
  shipments(): Promise<ShipmentView[]>
  purchases(): Promise<PurchaseView[]>
  cancellations(): Promise<CancellationView[]>
  review(): Promise<ReviewView[]>
  parsers(): Promise<ParserView[]>
  providers(): Promise<ProviderView[]>
  importEml(): Promise<{ imported: number; results: { subject: string; parserId: string | null; events: number }[] }>
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
  windowState(): Promise<{ maximized: boolean; fullScreen: boolean }>
  onWindowState(handler: (state: { maximized: boolean; fullScreen: boolean }) => void): () => void
  appVersion(): Promise<string>
  checkForUpdate(): Promise<{
    configured: boolean; currentVersion: string; available: boolean
    reason?: string; version?: string; sizeLabel?: string; notes?: string[]
  }>
  accounts(): Promise<AccountView[]>
  addAccount(account: NewAccountInput): Promise<AccountView>
  removeAccount(id: string): Promise<void>
  testAccount(connection: {
    host: string; port: number; useTls: boolean; username: string; password: string
  }): Promise<{ ok: boolean; message: string; folders?: string[] }>
  syncAccounts(): Promise<{
    accounts: number; fetched: number; stored: number
    failures: { email: string; error: string }[]
  }>
  encryptionAvailable(): Promise<boolean>
  logEntries(): Promise<LogEntryView[]>
  logPath(): Promise<string>
  logClear(): Promise<boolean>
  logOpenFolder(): Promise<void>
  crashReportUrl(index: number): Promise<{ url: string; signature: string; title: string } | null>
  reportRendererError(message: string, detail: string): Promise<LogEntryView>
  onSyncProgress(handler: (p: SyncProgress) => void): () => void
  onCrash(handler: (entry: LogEntryView) => void): () => void
  deleteAllData(includeAccounts: boolean): Promise<{
    deleted: boolean; messages?: number; events?: number; purchases?: number; items?: number
  }>
  discordSettings(): Promise<DiscordSettingsView>
  discordSetWebhook(url: string): Promise<{ ok: boolean; message: string }>
  discordSetRule(event: string, enabled: boolean): Promise<boolean>
  discordTest(): Promise<{ ok: boolean; message: string }>
  reparseAll(): Promise<{ examined: number; reparsed: number; missing: number }>
  resolveTracking(): Promise<{ attempted: number; resolved: number; failed: number }>
  exportMessage(id: string, format: 'eml' | 'html'): Promise<{
    saved: boolean; path?: string; reason?: string
  }>
  exportAllUnrecognised(): Promise<{ saved: number; folder?: string; reason?: string }>
  aycdStatus(): Promise<AycdStatusView>
  aycdSetKey(key: string): Promise<void>
  aycdClearKey(): Promise<void>
  aycdSetAddresses(addresses: string[]): Promise<string[]>
  aycdVerify(): Promise<{ ok: boolean; message: string }>
  aycdStart(): Promise<{ started: boolean; message: string }>
  aycdStop(): Promise<{ stopped: boolean }>
  downloadUpdate(): Promise<{ started: boolean }>
  installUpdate(): Promise<void>
  onUpdateProgress(handler: (p: { percent: number; bytesPerSecond: number }) => void): () => void
  onUpdateDownloaded(handler: (info: { version: string }) => void): () => void
  mailDir(): Promise<string>
  rescan(): Promise<{ scanned: number; recognised: number; unrecognised: number }>
  openMailDir(): Promise<string>
  chooseMailDir(): Promise<string>
  onMailUpdated(handler: () => void): () => void
  exportRedirectCsv(): Promise<{ written: boolean; path: string | null; rows: number }>
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window { api: Api }
}

export const api = window.api
