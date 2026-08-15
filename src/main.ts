import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from 'electron'

import { DesktopCapabilityBroker } from './desktop-capability-broker'
import { createDesktopCapabilityHandlers } from './desktop-capabilities'
import { isTrustedDesktopBridgeSender } from './desktop-security'
import { HarnessService } from './harness-service'
import { bootstrapDesktopProfile } from './profile-bootstrap'
import { HarnessState } from './types'

app.setName('DSH Desktop')
app.setPath('userData', join(app.getPath('appData'), app.name))
app.setAppLogsPath()

const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

let mainWindow: BrowserWindow | undefined
let harness: HarnessService | undefined
let harnessOrigin: string | undefined
let shuttingDown = false
let shutdownComplete = false
let state: HarnessState = {
  phase: 'stopped',
  message: 'Harness is not running.',
  logPath: '',
}

function resolveDshBin(): string {
  const packageJson = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = join(dirname(packageJson), 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`The bundled Harness executable is missing: ${bin}`)
  return bin
}

function loadingPagePath(): string {
  return join(app.getAppPath(), 'renderer', 'index.html')
}

async function showLoadingPage(): Promise<void> {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  await mainWindow.loadFile(loadingPagePath())
}

function showLoadingPageSafely(): void {
  void showLoadingPage().catch(error => {
    console.error('Could not load the desktop status page.', error)
  })
}

function openExternalUrl(url: string): void {
  void shell.openExternal(url).catch(error => {
    console.error(`Could not open external URL: ${url}`, error)
  })
}

function publishState(next: HarnessState): void {
  state = next
  if (mainWindow === undefined || mainWindow.isDestroyed()) return

  mainWindow.webContents.send('desktop:harness-state', next)
  if (next.phase === 'ready' && next.url !== undefined) {
    harnessOrigin = new URL(next.url).origin
    const targetWindow = mainWindow
    void targetWindow.loadURL(next.url).catch(error => {
      const stillCurrent =
        mainWindow === targetWindow &&
        !targetWindow.isDestroyed() &&
        state.phase === 'ready' &&
        state.url === next.url
      if (!stillCurrent) return

      harnessOrigin = undefined
      const detail = error instanceof Error ? error.message : String(error)
      publishState({
        phase: 'error',
        message: `Harness UI could not load: ${detail}`,
        logPath: next.logPath,
      })
    })
    return
  }

  if (next.phase === 'error') showLoadingPageSafely()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f5f6f3',
    title: 'DSH Desktop',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) openExternalUrl(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const targetOrigin = safeOrigin(url)
    const isHarnessPage = harnessOrigin !== undefined && targetOrigin === harnessOrigin
    const isLoadingPage = url === pathToFileURL(loadingPagePath()).href
    if (isHarnessPage || isLoadingPage) return

    event.preventDefault()
    if (url.startsWith('https://')) openExternalUrl(url)
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  return window
}

if (isPrimaryInstance) {
  app.on('second-instance', () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

async function startHarness(): Promise<void> {
  harnessOrigin = undefined
  await showLoadingPage()
  await harness?.start()
}

function installIpcHandlers(): void {
  const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
    const senderUrl = event.senderFrame?.url ?? ''
    const loadingPageUrl = pathToFileURL(loadingPagePath()).href
    if (!isTrustedDesktopBridgeSender(senderUrl, loadingPageUrl)) {
      throw new Error('Desktop bridge access was denied for this page.')
    }
  }

  ipcMain.handle('desktop:get-harness-state', event => {
    assertTrustedSender(event)
    return state
  })
  ipcMain.handle('desktop:retry-harness', async event => {
    assertTrustedSender(event)
    await startHarness()
  })
  ipcMain.handle('desktop:show-harness-log', event => {
    assertTrustedSender(event)
    if (state.logPath !== '') shell.showItemInFolder(state.logPath)
  })
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return

  installMenu()
  installIpcHandlers()

  mainWindow = createWindow()
  await showLoadingPage()

  const logPath = join(app.getPath('logs'), 'harness.log')
  const dshHome = join(app.getPath('userData'), 'harness')
  bootstrapDesktopProfile({
    dshHome,
    packageRoot: app.getAppPath(),
    productVersion: app.getVersion(),
  })
  const capabilityBroker = new DesktopCapabilityBroker(createDesktopCapabilityHandlers({
    isAppFocused: () => mainWindow?.isFocused() ?? false,
    notifications: {
      isSupported: () => Notification.isSupported(),
      show: params => {
        const notification = new Notification({ title: params.title, body: params.body ?? '' })
        notification.on('click', () => {
          if (mainWindow === undefined || mainWindow.isDestroyed()) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        })
        notification.show()
      },
    },
  }))
  harness = new HarnessService({
    dshBin: resolveDshBin(),
    dshHome,
    cwd: homedir(),
    logPath,
    nodeExecutable: process.execPath,
    profileName: 'desktop',
    capabilityBroker,
    onState: publishState,
  })

  await startHarness()
}).catch(error => {
  state = {
    phase: 'error',
    message: error instanceof Error ? error.message : String(error),
    logPath: app.getPath('logs'),
  }
  showLoadingPageSafely()
})

app.on('before-quit', event => {
  if (!isPrimaryInstance) return
  if (shutdownComplete) return
  event.preventDefault()
  if (shuttingDown) return

  shuttingDown = true
  const stopHarness = harness?.stop() ?? Promise.resolve()
  void stopHarness
    .catch(error => {
      console.error('Could not stop Harness cleanly.', error)
    })
    .finally(() => {
      shutdownComplete = true
      app.quit()
    })
})

app.on('window-all-closed', () => app.quit())
