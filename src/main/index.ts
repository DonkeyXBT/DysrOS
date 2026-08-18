import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron'
import { join } from 'node:path'
import { writeFileSync, watch, existsSync, mkdirSync } from 'node:fs'
import { autoUpdater } from 'electron-updater'
import { AppService } from './service.js'

let service: AppService
let mainWindow: BrowserWindow | null = null
let mailDir = ''
let rescanTimer: NodeJS.Timeout | null = null

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

app.whenReady().then(() => {
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
  ipcMain.handle('app-version', () => app.getVersion())

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
  ipcMain.handle('sync-accounts', async () => {
    const result = await service.syncAccounts()
    mainWindow?.webContents.send('mail-updated', result)
    return result
  })
  ipcMain.handle('encryption-available', () => safeStorage.isEncryptionAvailable())

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

  ipcMain.handle('open-external', (_event, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
