/**
 * Launches the built application and visits every screen, failing if any of
 * them throws or renders nothing.
 *
 * This exists because 0.0.1 shipped with a stale variable reference in the
 * Settings screen: React unmounted the whole tree and the window went blank
 * with no way back. Typechecking now catches that class of error, but a build
 * that cannot draw its own screens should never reach a release either way.
 *
 * Run with: npm run smoke
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const SCREENS = [
  'Dashboard', 'Inventory', 'Purchases', 'Sales',
  'Shipments', 'Reports', 'Settings',
]

const failures = []
const rendererErrors = []

function fail(message) {
  failures.push(message)
  console.error(`FAIL  ${message}`)
}

app.whenReady().then(async () => {
  require(path.join(__dirname, '..', 'dist', 'main', 'index.cjs'))
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    fail('no window was created')
    return finish()
  }

  win.webContents.on('console-message', (event) => {
    // Severity 3 is an error in Chromium's console.
    if (event.level === 'error' || event.level === 3) rendererErrors.push(event.message)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    fail(`renderer process gone: ${details.reason}`)
  })

  const hasApi = await win.webContents.executeJavaScript('typeof window.api !== "undefined"')
  if (!hasApi) fail('preload did not expose window.api')

  for (const screen of SCREENS) {
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === ${JSON.stringify(screen)})
        if (!button) return false
        button.click()
        return true
      })()
    `)
    if (!clicked) {
      fail(`no navigation button for ${screen}`)
      continue
    }

    await new Promise((resolve) => setTimeout(resolve, 600))

    const state = await win.webContents.executeJavaScript(`
      (() => {
        const root = document.getElementById('root')
        // The screen name lives in the title bar, not an <h1> on the page.
        const heading = document.querySelector('.titlebar-label')
        return {
          children: root ? root.children.length : 0,
          heading: heading ? heading.textContent.trim() : null,
          boundary: (document.body.innerText || '').includes('hit an error'),
        }
      })()
    `)

    if (state.children === 0) fail(`${screen} rendered an empty tree`)
    else if (state.boundary) fail(`${screen} fell through to the error boundary`)
    else if (state.heading !== screen) fail(`${screen} showed heading ${state.heading}`)
    else console.log(`ok    ${screen}`)
  }

  finish()
})

function finish() {
  for (const message of rendererErrors) fail(`renderer error: ${message}`)

  if (failures.length > 0) {
    console.error(`\n${failures.length} smoke failure(s)`)
    app.exit(1)
    return
  }
  console.log(`\nAll ${SCREENS.length} screens rendered.`)
  app.exit(0)
}
