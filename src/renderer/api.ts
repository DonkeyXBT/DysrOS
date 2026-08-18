export interface ShipmentView {
  id: string; direction: string; carrier: string
  trackingNumber: string | null; trackingUrl: string | null
  linked: string; title: string | null; quantity: number; status: string
  lastMovementAt: string | null; expectedDeliveryAt: string | null
  postalCode: string | null; city: string | null; dhlRedirectable: boolean
  linkedToPurchase: boolean
}
export interface PurchaseView {
  id: string; retailer: string; reference: string | null; orderedAt: string
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
