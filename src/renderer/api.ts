export interface ShipmentView {
  id: string; direction: string; carrier: string
  trackingNumber: string | null; trackingUrl: string | null
  linked: string; title: string | null; imageUrl: string | null
  quantity: number; status: string
  lastMovementAt: string | null; expectedDeliveryAt: string | null
  deliveryWindow: string | null
  postalCode: string | null; city: string | null; dhlRedirectable: boolean
  /** True when a marketplace attached a shipping label to its mail. */
  hasLabel: boolean
  redirect: {
    outcome: string; message: string; servicePoint: string | null; attemptedAt: string | null
  } | null
  linkedToPurchase: boolean
}

export interface ActivityView {
  id: string
  label: string
  step: string
  state: 'running' | 'done' | 'failed'
  done: number | null
  total: number | null
  startedAt: string
  endedAt: string | null
}

export interface SaleView {
  id: string
  itemId: string | null
  title: string
  imageUrl: string | null
  buyer: string | null
  note: string | null
  soldAt: string
  channel: string
  retailer: string | null
  orderRef: string | null
  grossMinor: number; gross: string
  vatMinor: number; vat: string
  includedVat: boolean
  costMinor: number | null; cost: string | null
  profitMinor: number | null; profit: string | null
}

export interface RedirectReportView {
  id: string
  trackingNumber: string | null
  title: string | null
  ok: boolean
  dryRun: boolean
  servicePoint: { name: string | null; distance: string | null; address: string | null } | null
  reason: string | null
  message: string
}
export interface BestSellerView {
  title: string
  units: number
  revenue: string
  revenueMinor: number
  profit: string | null
  profitMinor: number | null
  lastSoldAt: string
  imageUrl: string | null
}

export interface SeriesPointView {
  period: string
  revenueMinor: number
  profitMinor: number
}

export interface ActivityRowView {
  kind: 'order' | 'sale' | 'parcel'
  id: string
  title: string
  meta: string
  amount: string | null
  at: string
  status: string
  imageUrl: string | null
}

export interface DashboardView {
  bestSellers: BestSellerView[]
  allTimeBest: BestSellerView | null
  salesSeries: SeriesPointView[]
  activity: ActivityRowView[]
  pending: { units: number; value: string; oldestDays: number | null }
  vat: {
    rateBasisPoints: number; paidOnPurchases: string; collectedOnSales: string
    balance: string; balanceMinor: number
  }
  topProducts: {
    title: string; units: number; spend: string; spendMinor: number
    lastBoughtAt: string | null; imageUrl: string | null
  }[]
  bought: { orders: number; units: number; spend: string; shipped: number; delivered: number }
  inFlight: { units: number; parcels: number; awaitingCode: number }
  stock: { units: number; capital: string; capitalMinor: number }
  cancelled: { units: number; owed: string; owedMinor: number }
  profit: {
    net: string; netMinor: number; revenue: string; fees: string
    marginPercent: number; salesRecorded: number
    /** Sales whose goods were bought outside this application. */
    uncosted: number
    channels: { name: string; value: string; minor: number }[]
  }
  money: { out: string; in: string; salesRecorded: number }
  funnel: { label: string; hue: number; units: number; value: string }[]
  months: { label: string; capital: number }[]
  aging: { bucket: string; units: number; value: string; minor: number; stalled: boolean }[]
  series: { period: string; out: number; in: number }[]
  reviewCount: number
}

export interface ItemView {
  id: string; title: string; imageUrl: string | null
  costVatMinor: number; costNetMinor: number
  soldMinor: number | null; sold: string | null; soldVatMinor: number | null
  soldAt: string | null; soldVia: string | null; buyer: string | null
  profitMinor: number | null; profit: string | null
  brand: string | null; sku: string | null
  size: string | null; condition: string; status: string
  cost: string; costMinor: number
  purchasedAt: string | null; daysHeld: number | null
  location: string | null; retailer: string | null; orderRef: string | null
  carrier?: string | null; trackingNumber?: string | null
  shipmentStatus?: string | null; expectedDeliveryAt?: string | null
}

export interface PurchaseView {
  mailbox: string | null
  mailSubject: string | null
  id: string; kind: 'buy' | 'cancel'; retailer: string; reference: string | null; orderedAt: string
  title: string | null; quantity: number; unit: string; shipping: string
  total: string; totalMinor: number; totalsConsistent: boolean; status: string
  refundOutstanding: string | null
  carrier?: string | null; trackingNumber?: string | null; shipmentStatus?: string | null
}
export interface CancellationView {
  mailbox: string | null
  mailSubject: string | null
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
  dashboard(): Promise<DashboardView>
  inventory(): Promise<ItemView[]>
  /** The article photograph as a data URL, fetched once and kept on disk. */
  productImage(url: string): Promise<string | null>
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
    /** True when a mailbox still had mail waiting, which a follow-up run collects. */
    remaining?: boolean
    /** True when a sync was already running, so this request did nothing. */
    skipped?: boolean
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
  deleteRecord(
    kind: 'item' | 'purchase' | 'shipment' | 'sale',
    id: string,
  ): Promise<{ deleted: boolean }>
  discordSettings(): Promise<DiscordSettingsView>
  discordSetWebhook(url: string): Promise<{ ok: boolean; message: string }>
  discordSetRule(event: string, enabled: boolean): Promise<boolean>
  discordTest(): Promise<{ ok: boolean; message: string }>
  reparseAll(): Promise<{ examined: number; reparsed: number; missing: number }>
  resolveTracking(): Promise<{ attempted: number; resolved: number; failed: number }>
  exportMessage(id: string, format: 'eml' | 'html'): Promise<{
    saved: boolean; path?: string; reason?: string
  }>
  exportAllUnrecognised(only?: string[]): Promise<{ saved: number; folder?: string; reason?: string }>
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
  onUpdateAvailable(handler: (info: { version: string }) => void): () => void
  onUpdateDownloaded(handler: (info: { version: string }) => void): () => void
  mailDir(): Promise<string>
  rescan(): Promise<{ scanned: number; recognised: number; unrecognised: number }>
  openMailDir(): Promise<string>
  chooseMailDir(): Promise<string>
  onMailUpdated(handler: () => void): () => void
  exportRedirectCsv(): Promise<{ written: boolean; path: string | null; rows: number }>
  activity(): Promise<ActivityView[]>
  sellItems(ids: string[], input: {
    amountMinor: number; includesVat: boolean; perUnit?: boolean
    buyer?: string | null; note?: string | null; soldAt?: string
  }): Promise<{ sold: number; grossMinor: number; profitMinor: number; vatMinor: number }>
  unsellItems(ids: string[]): Promise<number>
  sales(): Promise<SaleView[]>
  salesSeries(days: number | null): Promise<SeriesPointView[]>
  saveLabel(shipmentId: string): Promise<{ saved: boolean; path?: string; reason?: string }>
  openLabel(shipmentId: string): Promise<{ opened: boolean; path?: string }>
  updateSale(id: string, input: {
    amountMinor?: number; includesVat?: boolean
    buyer?: string | null; note?: string | null; soldAt?: string
  }): Promise<SaleView | null>
  deleteSale(id: string): Promise<boolean>
  syncLookback(): Promise<number>
  setSyncLookback(days: number): Promise<number>
  vatPosition(): Promise<{
    rateBasisPoints: number; paidOnPurchases: string; collectedOnSales: string
    balance: string; balanceMinor: number
  }>
  onActivity(handler: (entries: ActivityView[]) => void): () => void
  redirectEmail(): Promise<string | null>
  setRedirectEmail(email: string): Promise<string | null>
  redirectParcels(ids: string[], dryRun: boolean): Promise<RedirectReportView[]>
  onRedirectProgress(handler: (p: {
    done: number; total: number; id: string; trackingNumber: string | null; step: string
  }) => void): () => void
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window { api: Api }
}

export const api = window.api
