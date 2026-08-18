import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron'
import { join } from 'node:path'
import { writeFileSync, watch, existsSync, mkdirSync } from 'node:fs'
import { autoUpdater } from 'electron-updater'
import { AppService } from './service.js'
import { ErrorLog, defaultLogPath } from '../core/log.js'
import { buildCrashReport, issueUrl } from '../core/crash-report.js'

const REPO = 'DonkeyXBT/DysrOS'

let service: AppService
let log: ErrorLog
let mainWindow: BrowserWindow | null = null
let mailDir = ''
let rescanTimer: NodeJS.Timeout | null = null
let hourlyTimer: NodeJS.Timeout | null = null
/** Guards against a scheduled sync starting on top of one already running. */
let syncInFlight = false

const HOURLY_SYNC_MS = 60 * 60 * 1000
/** How often a running sync pushes its results to the screens. Often enough to
 *  feel live, rarely enough not to re-query the database for every message. */
const LIVE_REFRESH_EVERY = 20

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
  skipped?: boolean
}> {
  if (syncInFlight) {
    return { accounts: 0, fetched: 0, stored: 0, failures: [], skipped: true }
  }
  syncInFlight = true
  log.record('info', 'sync', `${reason} sync started`)

  try {
    const result = await service.syncAccounts(undefined, (progress) => {
      mainWindow?.webContents.send('sync-progress', progress)
      if (progress.done % LIVE_REFRESH_EVERY === 0) {
        mainWindow?.webContents.send('mail-updated', { partial: true })
      }
    })
    for (const failure of result.failures) {
      log.record('warn', 'sync', new Error(failure.error), `account: ${failure.email}`)
    }
    log.record('info', 'sync', `${reason} sync finished: ${result.fetched} fetched, ${result.stored} new`)
    mainWindow?.webContents.send('mail-updated', result)
    return result
  } catch (error) {
    const entry = log.record('error', 'sync', error)
    mainWindow?.webContents.send('crash', entry)
    throw error
  } finally {
    syncInFlight = false
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
    void service.scanMailDir(mailDir).then((result) => {
      if (result.scanned > 0) mainWindow?.webContents.send('mail-updated', result)
    })
  }, 400)
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

  mainWindow.once('ready-to-show', () => mainWindow?.show())

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

  ipcMain.handle('download-update', async () => {
    await autoUpdater.downloadUpdate()
    return { started: true }
  })

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('accounts', () => service.listAccounts())
  ipcMain.handle('add-account', (_e, account) => service.addAccount(account))
  ipcMain.handle('remove-account', (_e, id: string) => service.removeAccount(id))
  ipcMain.handle('test-account', (_e, connection) => service.testAccount(connection))
  ipcMain.handle('sync-accounts', () => runSync('manual'))

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

  handle('discord-settings', () => service.discordSettings())
  handle('discord-set-webhook', (url: string) => service.setDiscordWebhook(url))
  handle('discord-set-rule', (event: string, enabled: boolean) => {
    service.setDiscordRule(event, enabled)
    return true
  })
  handle('discord-test', () => service.sendDiscordTest())
  handle('reparse-all', async () => {
    const result = await service.reparseAll()
    mainWindow?.webContents.send('mail-updated', result)
    return result
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
  hourlyTimer = setInterval(() => {
    void runSync('scheduled').catch(() => {
      // Already logged; a failed scheduled sync must not stop later ones.
    })
  }, HOURLY_SYNC_MS)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (hourlyTimer) clearInterval(hourlyTimer)
  // The watcher owns a repeating timer; leaving it running holds the process open.
  void service?.stopAycdWatch()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
