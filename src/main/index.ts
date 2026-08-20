import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron'
import { join } from 'node:path'
import { writeFileSync, watch, existsSync, mkdirSync } from 'node:fs'
import { autoUpdater } from 'electron-updater'
import { ActivityHub } from '../core/activity.js'
import { ImageCache } from './images.js'
import { RedirectWindow } from './redirect-window.js'
import { AppService } from './service.js'
import { ErrorLog, defaultLogPath } from '../core/log.js'
import { buildCrashReport, issueUrl } from '../core/crash-report.js'

const REPO = 'DonkeyXBT/DysrOS'

/**
 * This build's version, baked in at build time.
 *
 * `app.getVersion()` answers with Electron's own version when running from
 * source, so using it to decide whether stored mail has been read by this
 * build meant the decision was wrong in development — the one place mail is
 * re-read most often.
 */
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

let service: AppService
let images: ImageCache
/** Everything running in the background, for the activity list in the sidebar. */
const activity = new ActivityHub()
/** True while parcels are being redirected, so a second run cannot start. */
let redirecting = false
let log: ErrorLog
let mainWindow: BrowserWindow | null = null
let mailDir = ''
let rescanTimer: NodeJS.Timeout | null = null
let syncTimer: NodeJS.Timeout | null = null
let trackingTimer: NodeJS.Timeout | null = null
let trackingInFlight = false
let updateTimer: NodeJS.Timeout | null = null
let lastOfferedVersion: string | null = null
/** Guards against a scheduled sync starting on top of one already running. */
let syncInFlight = false
/** True when a sync was asked for while one was running, and is still owed. */
let syncAgainWhenDone = false

/**
 * How often to look for new mail.
 *
 * Every ten to twenty minutes rather than a fixed hour: an order confirmation
 * an hour stale is not much use, and the interval is varied so several
 * mailboxes are not all polled on the same beat.
 */
const SYNC_MIN_MS = 10 * 60 * 1000
const SYNC_MAX_MS = 20 * 60 * 1000
/**
 * Tracking codes are chased on their own schedule as well as after a sync.
 * A backlog of parcels cannot clear itself otherwise: a sync only resolves a
 * batch, and waiting an hour for the next one to take the following batch
 * leaves parcels without codes for no good reason.
 */
const TRACKING_SWEEP_MS = 10 * 60 * 1000
/** How often to ask whether a newer build has been published. */
const UPDATE_CHECK_MS = 5 * 60 * 1000
/** How often a running sync pushes its results to the screens. Often enough to
 *  feel live, rarely enough not to re-query the database for every message. */
const LIVE_REFRESH_EVERY = 20

/**
 * Follows retailer redirects to turn them into carrier barcodes.
 *
 * Runs on a timer as well as after each sync, so a parcel that could not be
 * resolved — the carrier had not registered it yet, the network was down — is
 * picked up shortly afterwards without anyone asking.
 */
async function sweepTracking(reason: string): Promise<void> {
  if (trackingInFlight) return
  trackingInFlight = true
  activity.start('tracking', 'Getting tracking codes', 'looking for parcels without a barcode')
  try {
    const result = await service.resolveTrackingCodes({
      limit: 60,
      onProgress: (done, total) => {
        activity.step('tracking', `following link ${done} of ${total}`, done, total)
        mainWindow?.webContents.send('sync-progress', {
          account: 'tracking',
          done,
          stored: total,
          subject: `Getting tracking codes (${done} of ${total})`,
        })
      },
    })
    if (result.attempted > 0) {
      log.record('info', 'tracking', `${reason}: resolved ${result.resolved} of ${result.attempted}`)
      mainWindow?.webContents.send('mail-updated', { tracking: result })
    }
    activity.finish('tracking', result.attempted === 0
      ? 'every parcel already has its code'
      : `found ${result.resolved} of ${result.attempted}`)

    // Mail says a parcel arrived, but a mail can be missed. DHL answers for
    // its own parcels, so they are asked directly on the same round.
    activity.start('carrier', 'Checking with DHL', 'asking about parcels still out')
    const status = await service.pollCarrierStatus({
      onProgress: (done, total) => activity.step('carrier', `parcel ${done} of ${total}`, done, total),
    })
    activity.finish(
      'carrier',
      status.asked === 0
        ? 'nothing still out with DHL'
        : `${status.moved} moved on, ${status.delivered} delivered`,
      status.failed < status.asked,
    )
    if (status.moved > 0) mainWindow?.webContents.send('mail-updated', { carrier: status })
  } catch (error) {
    log.record('warn', 'tracking', error)
    activity.finish('tracking', 'could not reach the carrier', false)
  } finally {
    trackingInFlight = false
  }
}

/**
 * Sends what has happened to Discord.
 *
 * Every route that changes something ends here — a sync, a re-read, mail
 * dropped into the folder — because the question the user asks is "did I get
 * told", not "which code path noticed".
 */
async function announce(reason: string): Promise<void> {
  try {
    const result = await service.flushNotifications()
    if (result.sent > 0) {
      log.record('info', 'discord', `${reason}: sent ${result.sent} notification(s)`)
      activity.start('discord', 'Discord', `sent ${result.sent} notification(s)`)
      activity.finish('discord', `sent ${result.sent} notification(s)`)
    }
    if (result.failed > 0) {
      log.record('warn', 'discord', new Error(`${result.failed} notification(s) not accepted`))
      activity.start('discord', 'Discord', 'not accepted')
      activity.finish('discord', `${result.failed} not accepted — will try again`, false)
    }
  } catch (error) {
    log.record('warn', 'discord', error)
  }
}

/** Queues the next sync, then keeps queueing after each one finishes. */
function scheduleNextSync(): void {
  if (syncTimer) clearTimeout(syncTimer)
  const delay = SYNC_MIN_MS + Math.random() * (SYNC_MAX_MS - SYNC_MIN_MS)
  syncTimer = setTimeout(() => {
    void runSync('scheduled')
      .catch(() => {
        // Already logged; a failed sync must not stop later ones.
      })
      // Scheduled from the end of a run rather than the start, so a slow
      // mailbox cannot have two syncs overlapping.
      .finally(scheduleNextSync)
  }, delay)
}

/**
 * Runs a sync, reporting progress per message and pushing partial results to
 * the interface as they land.
 *
 * Everything the sync produces is written before it finishes, so showing it as
 * it arrives is just a matter of telling the screens to re-read — which is what
 * removes any need to restart the application to see new mail.
 */
async function runSync(reason: 'manual' | 'scheduled'): Promise<{
  accounts: number
  fetched: number
  stored: number
  failures: { email: string; error: string }[]
  remaining?: boolean
  skipped?: boolean
}> {
  if (syncInFlight) {
    // Someone asked while a sync was already running — a second mailbox added,
    // or the button pressed twice. The request is remembered rather than
    // dropped: a mailbox connected mid-sync would otherwise wait for the next
    // scheduled pass, with nothing on screen to say why.
    syncAgainWhenDone = true
    return { accounts: 0, fetched: 0, stored: 0, failures: [], skipped: true }
  }
  syncInFlight = true
  syncAgainWhenDone = false
  log.record('info', 'sync', `${reason} sync started`)
  activity.start('sync', 'Syncing mail', `${reason} sync starting`)

  try {
    const result = await service.syncAccounts(undefined, (progress) => {
      activity.step(
        'sync',
        `${progress.account}: ${progress.done} read, ${progress.stored} new`,
        progress.done,
        null,
      )
      mainWindow?.webContents.send('sync-progress', progress)
      if (progress.done % LIVE_REFRESH_EVERY === 0) {
        mainWindow?.webContents.send('mail-updated', { partial: true })
      }
    })
    for (const failure of result.failures) {
      log.record('warn', 'sync', new Error(failure.error), `account: ${failure.email}`)
    }
    log.record(
      'info',
      'sync',
      `${reason} sync finished: ${result.fetched} fetched, ${result.stored} new`
        + (result.remaining ? ', more waiting' : ''),
    )
    activity.finish(
      'sync',
      `${result.fetched} read, ${result.stored} new${result.remaining ? ' · more to come' : ''}`,
    )
    // A mailbox that hit the ceiling still has mail waiting. Carrying on now,
    // rather than at the next scheduled pass, is the difference between a
    // large mailbox arriving today and arriving over the next several hours.
    if (result.remaining) syncAgainWhenDone = true
    mainWindow?.webContents.send('mail-updated', result)

    // Barcodes are only reachable by following the retailer's redirect, so the
    // lookup happens here rather than during parsing.
    await sweepTracking('after sync')

    // Only now is a parcel's story complete enough to tell: the barcode it was
    // waiting for is either resolved or not.
    await announce('after sync')

    return result
  } catch (error) {
    const entry = log.record('error', 'sync', error)
    activity.finish('sync', entry.message, false)
    mainWindow?.webContents.send('crash', entry)
    throw error
  } finally {
    syncInFlight = false
    if (syncAgainWhenDone) {
      syncAgainWhenDone = false
      // Detached: the caller of this run is waiting on its own result, not on
      // a run it never asked for.
      setTimeout(() => { void runSync('manual').catch(() => {}) }, 100)
    }
  }
}

/**
 * Re-scans the mail folder, coalescing bursts: a file copied in arrives as
 * several change events, and one scan per burst is enough.
 */
/**
 * Where mail is read from unless configured otherwise. Prefers a `fixtures/eml`
 * folder beside the app — the one already holding mail during development —
 * and otherwise a `mail` folder next to the database, created on first run.
 */
function defaultMailDir(): string {
  const fromEnv = process.env.RESELL_MAIL_DIR
  if (fromEnv) return fromEnv

  const beside = join(app.getAppPath(), 'fixtures', 'eml')
  if (existsSync(beside)) return beside

  const inUserData = join(app.getPath('userData'), 'mail')
  mkdirSync(inUserData, { recursive: true })
  return inUserData
}

function scheduleRescan(): void {
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = setTimeout(() => {
    void service.scanMailDir(mailDir).then(async (result) => {
      if (result.scanned > 0) {
        mainWindow?.webContents.send('mail-updated', result)
        await announce('after a folder scan')
      }
    })
  }, 400)
}

/** The size the design was drawn at. */
const DESIGN_WIDTH = 1440
const DESIGN_HEIGHT = 900
/** Below this the text stops being readable; above it, panels just look empty. */
const MIN_SCALE = 0.62
const MAX_SCALE = 1.25

function applyScale(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [width = DESIGN_WIDTH, height = DESIGN_HEIGHT] = mainWindow.getContentSize()
  const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT)
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
  mainWindow.webContents.setZoomFactor(Number(clamped.toFixed(3)))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    backgroundColor: '#0b0d12',
    // The design draws its own title bar, so the native frame is removed.
    frame: false,
    icon: join(app.getAppPath(), 'build', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    applyScale()
    mainWindow?.show()
  })

  // Scale the whole interface with the window rather than reflowing it.
  //
  // The design is laid out at 1440x900 and is dense: at a smaller window,
  // reflowing would push content below the fold and force scrolling through the
  // chrome. Scaling keeps every panel in view at any size, and text shrinks
  // with the panels so proportions stay exactly as designed.
  mainWindow.on('resize', applyScale)
  mainWindow.on('maximize', applyScale)
  mainWindow.on('unmaximize', applyScale)

  // Background work reports itself to the sidebar as it happens, so the
  // question "what is it doing?" never needs a restart to answer.
  activity.subscribe((entries) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('activity', entries)
    }
  })

  // The title bar's maximise button has two icons, so the renderer needs to
  // know which state the window is actually in — including when the user
  // double-clicks the bar or drags the window to an edge.
  const pushWindowState = () => {
    mainWindow?.webContents.send('window-state', {
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
    })
  }
  mainWindow.on('maximize', pushWindowState)
  mainWindow.on('unmaximize', pushWindowState)
  mainWindow.on('enter-full-screen', pushWindowState)
  mainWindow.on('leave-full-screen', pushWindowState)

  const devServer = process.env.VITE_DEV_SERVER_URL
  if (devServer) {
    void mainWindow.loadURL(devServer)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Wraps every IPC handler so a throw is recorded rather than only surfacing as
 * a rejected promise in the renderer, where it is easy to miss entirely.
 */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (error) {
      const entry = log.record('error', `ipc:${channel}`, error)
      mainWindow?.webContents.send('crash', entry)
      throw error
    }
  })
}

app.whenReady().then(() => {
  log = new ErrorLog(defaultLogPath(app.getPath('userData')))

  // A crash during a sync used to leave nothing behind. These land in the log
  // file synchronously, so the record survives the process dying.
  process.on('uncaughtException', (error) => {
    const entry = log.record('error', 'main:uncaught', error)
    mainWindow?.webContents.send('crash', entry)
  })
  process.on('unhandledRejection', (reason) => {
    const entry = log.record('error', 'main:unhandled-rejection', reason)
    mainWindow?.webContents.send('crash', entry)
  })
  log.record('info', 'app', `started ${app.getVersion()}`)
  /**
   * Passwords are encrypted with the OS keystore (DPAPI on Windows), so a copy
   * of the database file is useless on another machine or account. Where the OS
   * offers no keystore, encryption is refused rather than silently downgraded
   * to storing the password in the clear.
   */
  const encryptor = {
    encrypt(plaintext: string): string {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('The OS keystore is unavailable, so the password cannot be stored safely.')
      }
      return safeStorage.encryptString(plaintext).toString('base64')
    },
    decrypt(ciphertext: string): string {
      return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    },
  }

  service = new AppService(join(app.getPath('userData'), 'resell-ops.db'), encryptor)
  images = new ImageCache(join(app.getPath('userData'), 'product-images'))

  // Mail read by an older set of parsers is read again, from the raw copy kept
  // for exactly this, so what the parsers learned since applies to it too.
  if (service.needsReparse(APP_VERSION)) {
    activity.start('reparse', 'Re-reading stored mail', 'applying what the parsers learned')
    void service.reparseAll().then(async (result) => {
      service.markReparsed(APP_VERSION)
      activity.finish('reparse', `${result.reparsed} of ${result.examined} re-read`)
      if (result.reparsed > 0) mainWindow?.webContents.send('mail-updated', result)
      // Re-reading rebuilds parcels from their mail, so mail about a parcel
      // already recorded briefly stands on its own again. Following the links
      // straight away pairs them back up rather than leaving the list doubled
      // until the next sweep comes round.
      await sweepTracking('after re-reading')
      await announce('after re-reading')
    }).catch((error: unknown) => {
      log?.record('error', 'reparse', error)
      activity.finish('reparse', 'could not re-read stored mail', false)
    })
  }

  // Where mail comes from. Defaults to a folder beside the database, created on
  // first run; the app reads it by itself rather than asking anyone to pick
  // files. Overridable, so it can point at whatever already collects mail.
  mailDir = service.mailDir(defaultMailDir())
  void service.scanMailDir(mailDir).then((result) => {
    if (result.scanned > 0) mainWindow?.webContents.send('mail-updated', result)
  })
  try {
    watch(mailDir, { persistent: false }, scheduleRescan)
  } catch {
    // Folder may not exist yet on a cold start; the next launch picks it up.
  }

  ipcMain.handle('window-minimize', () => mainWindow?.minimize())
  ipcMain.handle('window-toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window-close', () => mainWindow?.close())
  ipcMain.handle('window-state', () => ({
    maximized: mainWindow?.isMaximized() ?? false,
    fullScreen: mainWindow?.isFullScreen() ?? false,
  }))
  // app.getVersion() reports Electron's own version when running from source,
  // which is misleading in the title bar. package.json is the real answer.
  ipcMain.handle('app-version', () => {
    if (app.isPackaged) return app.getVersion()
    try {
      return require(join(app.getAppPath(), 'package.json')).version as string
    } catch {
      return app.getVersion()
    }
  })

  /**
   * Updates come from GitHub Releases, which is also where the installer is
   * published. Nothing is downloaded without being asked for: the check reports
   * what is available and the download is a separate, explicit call.
   */
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update-downloaded', { version: info.version })
  })

  ipcMain.handle('check-for-update', async () => {
    const currentVersion = app.getVersion()

    // A development run has no packaged build to replace, so checking would
    // only ever produce a confusing answer.
    if (!app.isPackaged) {
      return {
        configured: false,
        currentVersion,
        available: false,
        reason: 'Updates apply to installed builds. This is running from source.',
      }
    }

    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version ?? null
      const available = version !== null && version !== currentVersion
      return {
        configured: true,
        currentVersion,
        available,
        version: version ?? undefined,
        notes: typeof result?.updateInfo?.releaseNotes === 'string'
          ? [result.updateInfo.releaseNotes]
          : undefined,
        sizeLabel: result?.updateInfo?.releaseDate
          ? `released ${String(result.updateInfo.releaseDate).slice(0, 10)}`
          : undefined,
      }
    } catch (error) {
      return {
        configured: true,
        currentVersion,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })

  /**
   * Asks whether a newer build exists and tells the window when one appears.
   *
   * Only the first sighting of a given version is announced: repeating it every
   * five minutes would turn a useful notice into noise.
   */
  async function checkForUpdate(): Promise<void> {
    if (!app.isPackaged) return
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!version || version === app.getVersion() || version === lastOfferedVersion) return
      lastOfferedVersion = version
      log.record('info', 'updater', `update available: ${version}`)
      mainWindow?.webContents.send('update-available', { version })
    } catch (error) {
      // A failed check is not worth surfacing; the next one is five minutes away.
      log.record('warn', 'updater', error)
    }
  }

  updateTimer = setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS)
  setTimeout(() => void checkForUpdate(), 15_000)

  ipcMain.handle('download-update', async () => {
    await autoUpdater.downloadUpdate()
    return { started: true }
  })

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('accounts', () => service.listAccounts())
  ipcMain.handle('add-account', (_e, account) => {
    const added = service.addAccount(account)
    // A mailbox just connected has everything to fetch; waiting ten minutes to
    // start would make the app look broken at exactly the wrong moment.
    setTimeout(() => {
      void runSync('manual').catch(() => {})
    }, 500)
    return added
  })
  ipcMain.handle('remove-account', (_e, id: string) => service.removeAccount(id))
  ipcMain.handle('test-account', (_e, connection) => service.testAccount(connection))
  ipcMain.handle('sync-accounts', () => runSync('manual'))

  handle('resolve-tracking', async () => {
    activity.start('tracking', 'Getting tracking codes', 'asked for by hand')
    const result = await service.resolveTrackingCodes({
      limit: 200,
      onProgress: (done, total) =>
        activity.step('tracking', `following link ${done} of ${total}`, done, total),
    })
    activity.finish('tracking', `found ${result.resolved} of ${result.attempted}`)
    log.record('info', 'tracking', `manual resolve: ${result.resolved} of ${result.attempted}`)
    mainWindow?.webContents.send('mail-updated', { tracking: result })
    return result
  })

  ipcMain.handle('encryption-available', () => safeStorage.isEncryptionAvailable())

  handle('log-entries', () => log.recent(200))
  handle('log-path', () => log.path())
  handle('log-clear', () => {
    log.clear()
    return true
  })
  handle('log-open-folder', () => shell.showItemInFolder(log.path()))
  handle('crash-report-url', (entryIndex: number) => {
    const entry = log.recent(200)[entryIndex]
    if (!entry) return null
    const report = buildCrashReport(entry, {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    }, log.recent(200))
    return { url: issueUrl(REPO, report), signature: report.signature, title: report.title }
  })

  // The confirmation is drawn by the application itself, so it matches the rest
  // of the interface rather than appearing as a system dialog.
  handle('delete-all-data', (includeAccounts: boolean) => {
    const before = service.deleteAllData({ includeAccounts })
    log.record('warn', 'app', new Error('all data deleted by request'), JSON.stringify(before))
    mainWindow?.webContents.send('mail-updated', {})
    return { deleted: true, ...before }
  })

  handle('export-message', async (id: string, format: 'eml' | 'html') => {
    const file = await service.exportMessage(id, format)
    if (!file) {
      return { saved: false, reason: 'No copy of this message was kept. Sync again to collect it.' }
    }
    const picked = await dialog.showSaveDialog({
      title: 'Save message',
      defaultPath: file.name,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (picked.canceled || !picked.filePath) return { saved: false }
    writeFileSync(picked.filePath, file.content)
    return { saved: true, path: picked.filePath }
  })

  handle('export-all-unrecognised', async (only?: string[]) => {
    // A stack of identical mail needs one sample, not fifty: the screen can
    // ask for exactly the ones it is showing.
    const available = new Set(service.exportableReviewIds())
    const ids = only?.length
      ? only.filter((id) => available.has(id))
      : [...available]
    if (ids.length === 0) {
      return { saved: 0, reason: 'Nothing in the queue has a stored copy to export.' }
    }
    const picked = await dialog.showOpenDialog({
      title: 'Choose a folder for the unrecognised mail',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (picked.canceled || !picked.filePaths[0]) return { saved: 0 }

    let saved = 0
    for (const id of ids) {
      const file = await service.exportMessage(id, 'eml')
      if (!file) continue
      writeFileSync(join(picked.filePaths[0], file.name), file.content)
      saved += 1
    }
    return { saved, folder: picked.filePaths[0] }
  })

  handle('delete-record', (kind: 'item' | 'purchase' | 'shipment' | 'sale', id: string) => {
    const result = service.deleteRecord(kind, id)
    mainWindow?.webContents.send('mail-updated', { deleted: kind })
    return result
  })

  handle('discord-settings', () => service.discordSettings())
  handle('discord-set-webhook', (url: string) => service.setDiscordWebhook(url))
  handle('discord-set-rule', (event: string, enabled: boolean) => {
    service.setDiscordRule(event, enabled)
    return true
  })
  handle('discord-test', () => service.sendDiscordTest())
  handle('reparse-all', async () => {
    activity.start('reparse', 'Re-reading stored mail', 'running the parsers again')
    try {
      const result = await service.reparseAll()
      activity.finish('reparse', `${result.reparsed} of ${result.examined} re-read`)
      mainWindow?.webContents.send('mail-updated', result)
      return result
    } catch (error) {
      activity.finish('reparse', 'could not re-read stored mail', false)
      throw error
    }
  })

  ipcMain.handle('aycd-status', () => service.aycdStatus())
  ipcMain.handle('aycd-set-key', (_e, key: string) => service.setAycdApiKey(key))
  ipcMain.handle('aycd-clear-key', () => service.clearAycdApiKey())
  ipcMain.handle('aycd-set-addresses', (_e, addresses: string[]) =>
    service.setAycdAddresses(addresses))
  ipcMain.handle('aycd-verify', () => service.verifyAycd())
  ipcMain.handle('aycd-start', () => {
    const result = service.startAycdWatch()
    if (result.started) mainWindow?.webContents.send('mail-updated', {})
    return result
  })
  ipcMain.handle('aycd-stop', async () => {
    await service.stopAycdWatch()
    return { stopped: true }
  })

  ipcMain.handle('mail-dir', () => mailDir)
  ipcMain.handle('rescan', async () => service.scanMailDir(mailDir))
  ipcMain.handle('open-mail-dir', () => shell.openPath(mailDir))
  ipcMain.handle('choose-mail-dir', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose the folder to read mail from',
      properties: ['openDirectory'],
    })
    if (picked.canceled || !picked.filePaths[0]) return mailDir
    mailDir = picked.filePaths[0]
    service.setSetting('mail_dir', mailDir)
    await service.scanMailDir(mailDir)
    return mailDir
  })

  ipcMain.handle('summary', () => service.summary())
  ipcMain.handle('shipments', () => service.listShipments())
  ipcMain.handle('dashboard', () => service.dashboard())
  ipcMain.handle('inventory', () => service.listInventory())
  ipcMain.handle('product-image', (_event, url: unknown) =>
    typeof url === 'string' ? images.get(url) : null)

  ipcMain.handle('activity', () => activity.list())
  handle('sell-items', (ids: string[], input: {
    amountMinor: number; includesVat: boolean; perUnit?: boolean
    buyer?: string | null; note?: string | null; soldAt?: string
  }) => {
    const result = service.sellItems(ids, input)
    log.record('info', 'sale',
      `${result.sold} unit(s) sold for ${(result.grossMinor / 100).toFixed(2)}`)
    mainWindow?.webContents.send('mail-updated', { sold: result.sold })
    return result
  })
  handle('unsell-items', (ids: string[]) => {
    const count = service.unsellItems(ids)
    mainWindow?.webContents.send('mail-updated', { unsold: count })
    return count
  })
  ipcMain.handle('vat-position', () => service.vatPosition())
  ipcMain.handle('sync-lookback', () => service.syncLookbackDays())
  handle('set-sync-lookback', (days: number) => {
    const applied = service.setSyncLookbackDays(days)
    log.record('info', 'sync', `lookback set to ${applied} day(s)`)
    return applied
  })
  ipcMain.handle('sales', () => service.listSales())
  ipcMain.handle('sales-series', (_event, days: number | null) => service.salesSeries(days))
  handle('save-label', async (shipmentId: string) => {
    const label = await service.labelFor(shipmentId)
    if (!label) {
      return { saved: false, reason: 'No label was attached to the mail for this parcel.' }
    }
    const picked = await dialog.showSaveDialog({
      title: 'Save the shipping label',
      defaultPath: join(app.getPath('downloads'), label.name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (picked.canceled || !picked.filePath) return { saved: false }
    writeFileSync(picked.filePath, label.content)
    return { saved: true, path: picked.filePath }
  })
  handle('open-label', async (shipmentId: string) => {
    const label = await service.labelFor(shipmentId)
    if (!label) return { opened: false }
    // Written beside the database rather than into Downloads: this is a
    // temporary copy so the system's own reader can show it.
    const path = join(app.getPath('temp'), label.name)
    writeFileSync(path, label.content)
    await shell.openPath(path)
    return { opened: true, path }
  })
  handle('update-sale', (id: string, input: {
    amountMinor?: number; includesVat?: boolean
    buyer?: string | null; note?: string | null; soldAt?: string
  }) => {
    const sale = service.updateSale(id, input)
    mainWindow?.webContents.send('mail-updated', { sale: id })
    return sale
  })
  handle('delete-sale', (id: string) => {
    const removed = service.deleteSale(id)
    mainWindow?.webContents.send('mail-updated', { sale: id })
    return removed
  })
  ipcMain.handle('redirect-email', () => service.redirectEmail())
  ipcMain.handle('redirect-set-email', (_event, email: string) => service.setRedirectEmail(email))

  // Redirecting changes where a real parcel actually goes, so it runs only
  // when asked, for exactly the parcels named, and never twice at once.
  ipcMain.handle('redirect-parcels', async (_event, ids: string[], dryRun: boolean) => {
    if (redirecting) return []
    redirecting = true
    // Shown rather than hidden: the user can watch what is being done on their
    // behalf, and step in if DHL asks something this does not know to answer.
    const page = new RedirectWindow({ show: true })
    activity.start('redirect', dryRun ? 'Testing a redirect' : 'Redirecting parcels',
      `${ids.length} parcel${ids.length === 1 ? '' : 's'}`)
    try {
      const reports = await service.redirectShipments(ids, {
        page,
        dryRun,
        onProgress: (done, total, current) => {
          activity.step(
            'redirect',
            `${current.trackingNumber ?? 'parcel'}: ${current.step}`,
            done,
            total,
          )
          mainWindow?.webContents.send('redirect-progress', { done, total, ...current })
        },
      })
      const accepted = reports.filter((report) => report.ok).length
      activity.finish('redirect', `${accepted} of ${reports.length} accepted`, accepted > 0)
      for (const report of reports) {
        log?.record(
          report.ok ? 'info' : 'warn',
          'redirect',
          `${report.trackingNumber ?? 'unknown parcel'}: ${report.message}`,
        )
      }
      return reports
    } catch (error) {
      log?.record('error', 'redirect', error)
      activity.finish('redirect', 'could not reach DHL', false)
      throw error
    } finally {
      page.close()
      redirecting = false
      mainWindow?.webContents.send('mail-updated', { reason: 'redirect' })
    }
  })

  ipcMain.handle('purchases', () => service.listPurchases())
  ipcMain.handle('cancellations', () => service.listCancellations())
  ipcMain.handle('review', () => service.listReviewQueue())
  ipcMain.handle('parsers', () => service.listParsers())
  ipcMain.handle('providers', () => service.listProviders())

  ipcMain.handle('import-eml', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import email files',
      filters: [{ name: 'Email', extensions: ['eml'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (picked.canceled) return { imported: 0, results: [] }

    const results = []
    for (const path of picked.filePaths) {
      results.push(await service.importEml(path))
    }
    return { imported: results.length, results }
  })

  ipcMain.handle('export-redirect-csv', async () => {
    const csv = service.redirectCsv()
    const picked = await dialog.showSaveDialog({
      title: 'Export trackings.csv for the DHL redirect tool',
      defaultPath: 'trackings.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (picked.canceled || !picked.filePath) return { written: false, path: null, rows: 0 }
    writeFileSync(picked.filePath, csv, 'utf8')
    return { written: true, path: picked.filePath, rows: csv.split('\n').length - 1 }
  })

  handle('report-renderer-error', (message: string, detail: string) => {
    const entry = log.record('error', 'renderer', new Error(message), detail)
    return entry
  })

  ipcMain.handle('open-external', (_event, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })

  // Catch up on anything that arrived while the application was closed, then
  // keep checking. A missed email should never need a manual sync to notice.
  scheduleNextSync()

  trackingTimer = setInterval(() => {
    void sweepTracking('scheduled sweep')
  }, TRACKING_SWEEP_MS)

  // Anything left unresolved from a previous run is picked up on launch rather
  // than waiting for the first timer to fire.
  setTimeout(() => void sweepTracking('startup'), 8000)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (syncTimer) clearTimeout(syncTimer)
  if (trackingTimer) clearInterval(trackingTimer)
  if (updateTimer) clearInterval(updateTimer)
  // The watcher owns a repeating timer; leaving it running holds the process open.
  void service?.stopAycdWatch()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
