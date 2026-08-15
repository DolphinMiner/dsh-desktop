import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  screen,
  shell,
} from 'electron'
import {
  createEvent,
  DesktopRendererCommand,
  parseAddGitReviewCommentInput,
  parseBeginOAuthInput,
  parseCancelOAuthInput,
  parseConnectApiKeyInput,
  parseDeleteGitReviewCommentInput,
  parseDisconnectConnectionInput,
  parseDesktopGitCommitConfirmInput,
  parseDesktopGitCommitPreviewInput,
  parseDesktopGitIndexMutationInput,
  parseDesktopGitPushConfirmInput,
  parseDesktopGitPushPreviewInput,
  parseDesktopGitRevertConfirmInput,
  parseDesktopGitRevertPreviewInput,
  parseDesktopGitReviewInput,
  parseDesktopGitReviewCommentsInput,
  parseDesktopWorktreeCleanupConfirmInput,
  parseDesktopWorktreeCleanupPreviewInput,
  parseDesktopWorktreeRecoveryConfirmInput,
  parseDesktopWorktreeRecoveryPreviewInput,
  parseDesktopWorktreeHandoffConfirmInput,
  parseDesktopWorktreeHandoffPreflightInput,
  parseSelectComputerTargetInput,
  WorktreeSummary,
} from '@dolphinminer/dsh-desktop-protocol'

import { ComputerCaptureStore, ComputerObserver } from './computer-observer'
import { ComputerActionAuditStore } from './computer-action-audit'
import { ConnectionManager } from './connection-manager'
import { ConnectionRegistry } from './connection-registry'
import { CredentialVault, safeStorageBackend } from './credential-vault'
import { DesktopCapabilityBroker } from './desktop-capability-broker'
import { createDesktopCapabilityHandlers } from './desktop-capabilities'
import { DesktopActivitySnapshot, DesktopActivityTracker } from './desktop-activity'
import { DesktopCommandQueue, parseDesktopDeepLink } from './desktop-navigation'
import { isTrustedDesktopBridgeSender } from './desktop-security'
import { HarnessService } from './harness-service'
import { HarnessRecoveryController, HarnessRecoverySchedule } from './harness-recovery'
import { GitCommitController } from './git-commit-controller'
import { GitReviewCommentController } from './git-review-comment-controller'
import { GitReviewCommentStore } from './git-review-comments'
import { GitIndexController, GitRepositoryMutationQueue } from './git-index-controller'
import { GitMutationJournal } from './git-mutation-journal'
import { GitPushController } from './git-push-controller'
import { GitRevertController } from './git-revert-controller'
import { GitService } from './git-service'
import { GitTurnAttributionService } from './git-turn-attribution'
import { GitTurnAttributionJournal } from './git-turn-attribution-journal'
import { McpCredentialProxy } from './mcp-credential-proxy'
import { NativeComputerHelper } from './native-computer-helper'
import { EncryptedOAuthStateStore, LinearOAuthCoordinator } from './oauth-provider'
import { bootstrapDesktopProfile } from './profile-bootstrap'
import { HarnessState } from './types'
import { PersistedWindowState, WindowStateStore } from './window-state'
import { resolveWorkspaceTarget, WorkspacePathError } from './workspace-path'
import { WorkspaceGitCapabilityService } from './workspace-git'
import { WorktreeCleanupController } from './worktree-cleanup-controller'
import { WorktreeHandoffController } from './worktree-handoff-controller'
import { WorktreeHandoffJournal } from './worktree-handoff-journal'
import { WorktreeManager } from './worktree-manager'
import { WorktreeRecoveryController } from './worktree-recovery-controller'
import { summarizeWorktreeRecord, WorktreeRegistry } from './worktree-registry'

app.setName('DSH Desktop')
const developmentUserData = app.isPackaged ? undefined : process.env.DSH_DESKTOP_USER_DATA?.trim()
app.setPath('userData', developmentUserData === undefined || developmentUserData === ''
  ? join(app.getPath('appData'), app.name)
  : resolve(developmentUserData))
app.setAppLogsPath()

const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

let mainWindow: BrowserWindow | undefined
let harness: HarnessService | undefined
let harnessRecovery: HarnessRecoveryController | undefined
let mcpProxy: McpCredentialProxy | undefined
let computerObserver: ComputerObserver | undefined
let windowStateStore: WindowStateStore | undefined
let harnessOrigin: string | undefined
let oauthCoordinator: LinearOAuthCoordinator | undefined
let shuttingDown = false
let shutdownComplete = false
let state: HarnessState = {
  phase: 'stopped',
  message: 'Harness is not running.',
  logPath: '',
}
const pendingOAuthLinks: string[] = []
const commandQueue = new DesktopCommandQueue()
let activitySnapshot: DesktopActivitySnapshot = { runningSessionIds: [], workspacePaths: {} }

function updateDesktopActivity(snapshot: DesktopActivitySnapshot): void {
  activitySnapshot = snapshot
  const count = snapshot.runningSessionIds.length
  const title = count === 0
    ? 'DSH Desktop'
    : `DSH Desktop (${String(count)} ${count === 1 ? 'task' : 'tasks'} running)`
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setTitle(title)
  if (process.platform === 'darwin') app.dock?.setBadge(count === 0 ? '' : String(count))
}

const activityTracker = new DesktopActivityTracker(updateDesktopActivity)

function assertActiveWorkspace(sessionId: string, workspaceRoot: string, signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('The desktop file request was cancelled.')
    error.name = 'AbortError'
    throw error
  }
  if (!activityTracker.isRunningInWorkspace(sessionId, workspaceRoot)) {
    throw new WorkspacePathError('BAD_MESSAGE', 'The workspace is not active for this running session.')
  }
}

function assertKnownWorkspace(sessionId: string, workspaceRoot: string, signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The desktop Git request was cancelled.', 'AbortError')
  if (!activityTracker.isKnownInWorkspace(sessionId, workspaceRoot)) {
    throw new WorkspacePathError('BAD_MESSAGE', 'The workspace does not belong to this Harness session.')
  }
}

function assertIdleWorkspace(sessionId: string, workspaceRoot: string, signal: AbortSignal): void {
  assertKnownWorkspace(sessionId, workspaceRoot, signal)
  if (activityTracker.isRunning(sessionId)) {
    throw new WorkspacePathError('CONFLICT', 'Wait for the agent task to stop before changing Git state.')
  }
}

function assertActiveSession(sessionId: string, signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The desktop request was cancelled.', 'AbortError')
  if (!activityTracker.isRunning(sessionId)) {
    throw new WorkspacePathError('BAD_MESSAGE', 'Computer actions require an active agent session.')
  }
}

function registerDesktopProtocol(): boolean {
  if (process.defaultApp && process.argv[1] !== undefined) {
    return app.setAsDefaultProtocolClient('dsh-desktop', process.execPath, [resolve(process.argv[1])])
  }
  return app.setAsDefaultProtocolClient('dsh-desktop')
}

const desktopProtocolRegistered = isPrimaryInstance && registerDesktopProtocol()

function isOAuthLink(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-desktop:' && url.hostname === 'oauth'
  } catch {
    return false
  }
}

function publishOAuthResult(ok: boolean, message: string): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop:oauth-result', { ok, message })
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function receiveOAuthLink(url: string): void {
  if (!isOAuthLink(url)) return
  const coordinator = oauthCoordinator
  if (coordinator === undefined) {
    pendingOAuthLinks.push(url)
    return
  }
  void coordinator.handleCallback(url).then(() => {
    publishOAuthResult(true, 'Linear connected successfully.')
  }).catch(error => {
    publishOAuthResult(false, error instanceof Error ? error.message : 'Linear could not be connected.')
  })
}

function canDeliverRendererCommand(): boolean {
  if (mainWindow === undefined || mainWindow.isDestroyed() || state.phase !== 'ready' ||
    harnessOrigin === undefined) return false
  return safeOrigin(mainWindow.webContents.getURL()) === harnessOrigin
}

function flushRendererCommands(): void {
  if (!canDeliverRendererCommand()) return
  commandQueue.drain(command => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return false
    mainWindow.webContents.send('desktop:command', command)
    return true
  })
}

function focusMainWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function dispatchRendererCommand(command: DesktopRendererCommand): void {
  commandQueue.enqueue(command)
  focusMainWindow()
  flushRendererCommands()
}

function receiveDesktopLink(url: string): void {
  if (isOAuthLink(url)) {
    receiveOAuthLink(url)
    return
  }
  const command = parseDesktopDeepLink(url)
  if (command !== undefined) dispatchRendererCommand(command)
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveDesktopLink(url)
})

function resolveDshBin(): string {
  const packageJson = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = join(dirname(packageJson), 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`The bundled Harness executable is missing: ${bin}`)
  return bin
}

function resolveComputerHelper(): string {
  if (process.platform !== 'darwin') {
    throw new Error('Computer observation is only available on macOS.')
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'helpers', 'DSHComputerHelper')
    : join(app.getAppPath(), 'build', 'native', 'DSHComputerHelper')
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
  const previousPhase = state.phase
  state = next
  if (next.phase !== 'ready') activityTracker.clear()
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

  if (next.phase === 'error' && previousPhase !== 'error') showLoadingPageSafely()
}

function captureWindowState(window: BrowserWindow): PersistedWindowState {
  return {
    version: 1,
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
  }
}

function createWindow(restoredState?: PersistedWindowState): BrowserWindow {
  const window = new BrowserWindow({
    ...(restoredState?.bounds ?? { width: 1440, height: 920 }),
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

  window.once('ready-to-show', () => {
    if (restoredState?.maximized === true) window.maximize()
    window.show()
  })
  window.webContents.on('did-finish-load', flushRendererCommands)
  window.on('page-title-updated', event => {
    event.preventDefault()
    updateDesktopActivity(activitySnapshot)
  })

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

  const saveWindowState = (): void => {
    if (!window.isDestroyed()) windowStateStore?.schedule(captureWindowState(window))
  }
  window.on('move', saveWindowState)
  window.on('resize', saveWindowState)
  window.on('maximize', saveWindowState)
  window.on('unmaximize', saveWindowState)
  window.on('close', saveWindowState)

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  return window
}

if (isPrimaryInstance) {
  app.on('second-instance', (_event, argv) => {
    for (const argument of argv) receiveDesktopLink(argument)
    focusMainWindow()
  })
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

async function launchHarness(): Promise<void> {
  harnessOrigin = undefined
  await showLoadingPage()
  await harness?.start()
}

async function restartHarness(): Promise<void> {
  if (harnessRecovery === undefined) {
    await launchHarness()
    return
  }
  await harnessRecovery.restartNow()
}

function formatRecoveryDelay(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(milliseconds)} milliseconds`
  const seconds = Math.ceil(milliseconds / 1_000)
  return `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`
}

function publishRecoverySchedule(schedule: HarnessRecoverySchedule): void {
  const failed = state.phase === 'error'
    ? state
    : { phase: 'error' as const, message: 'Harness stopped unexpectedly.', logPath: state.logPath }
  publishState({
    ...failed,
    message: `${failed.message} Restarting automatically in ${formatRecoveryDelay(schedule.delayMs)} ` +
      `(attempt ${String(schedule.attempt)} of ${String(schedule.maxAttempts)}).`,
    recovery: {
      attempt: schedule.attempt,
      maxAttempts: schedule.maxAttempts,
      retryAt: schedule.retryAt,
    },
  })
}

function publishRecoveryExhausted(maxAttempts: number): void {
  const failed = state.phase === 'error'
    ? state
    : { phase: 'error' as const, message: 'Harness stopped unexpectedly.', logPath: state.logPath }
  publishState({
    phase: 'error',
    message: `${failed.message} Automatic recovery paused after ${String(maxAttempts)} attempts.`,
    logPath: failed.logPath,
  })
}

function installIpcHandlers(
  connections: ConnectionManager,
  computer: ComputerObserver,
  git: WorkspaceGitCapabilityService,
  gitIndex: GitIndexController,
  gitCommit: GitCommitController,
  gitRevert: GitRevertController,
  gitPush: GitPushController,
  comments: GitReviewCommentController,
  worktrees: WorktreeManager,
  worktreeCleanup: WorktreeCleanupController,
  worktreeRecovery: WorktreeRecoveryController,
  worktreeHandoff: WorktreeHandoffController,
  publishWorktreeChange: (worktree: WorktreeSummary) => void,
  publishWorktreeReconciliation: (snapshot: ReturnType<WorktreeManager['snapshot']>) => void,
): void {
  const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
    const senderUrl = event.senderFrame?.url ?? ''
    const loadingPageUrl = pathToFileURL(loadingPagePath()).href
    if (!isTrustedDesktopBridgeSender(senderUrl, loadingPageUrl, harnessOrigin)) {
      throw new Error('Desktop bridge access was denied for this page.')
    }
  }

  const validInput = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('The desktop request is invalid.')
    return value
  }

  ipcMain.handle('desktop:get-harness-state', event => {
    assertTrustedSender(event)
    return state
  })
  ipcMain.handle('desktop:retry-harness', async event => {
    assertTrustedSender(event)
    await restartHarness()
  })
  ipcMain.handle('desktop:show-harness-log', event => {
    assertTrustedSender(event)
    if (state.logPath !== '') shell.showItemInFolder(state.logPath)
  })
  ipcMain.handle('desktop:pick-project-directory', async event => {
    assertTrustedSender(event)
    if (mainWindow === undefined || mainWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Project',
      buttonLabel: 'Open',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('desktop:git:review', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitReviewInput(value))
    const signal = new AbortController().signal
    const repository = await git.discover(input, signal)
    return git.review({ ...input, repositoryRoot: repository.root }, signal)
  })
  ipcMain.handle('desktop:git:index:mutate', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitIndexMutationInput(value))
    return gitIndex.mutate(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:commit:preview', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitCommitPreviewInput(value))
    return gitCommit.preview(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:commit:confirm', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitCommitConfirmInput(value))
    return gitCommit.confirm(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:revert:preview', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitRevertPreviewInput(value))
    return gitRevert.preview(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:revert:confirm', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitRevertConfirmInput(value))
    return gitRevert.confirm(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:push:preview', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitPushPreviewInput(value))
    return gitPush.preview(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:push:confirm', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitPushConfirmInput(value))
    return gitPush.confirm(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:git:comments:list', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopGitReviewCommentsInput(value))
    const signal = new AbortController().signal
    return comments.list(input, signal)
  })
  ipcMain.handle('desktop:git:comments:add', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseAddGitReviewCommentInput(value))
    const signal = new AbortController().signal
    return comments.add(input, signal)
  })
  ipcMain.handle('desktop:git:comments:remove', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDeleteGitReviewCommentInput(value))
    const signal = new AbortController().signal
    return comments.remove(input, signal)
  })
  ipcMain.handle('desktop:worktrees:list', event => {
    assertTrustedSender(event)
    return worktrees.snapshot()
  })
  ipcMain.handle('desktop:worktrees:reconcile', async event => {
    assertTrustedSender(event)
    const result = await worktrees.reconcile(new AbortController().signal)
    publishWorktreeReconciliation(result.snapshot)
    return result.snapshot
  })
  ipcMain.handle('desktop:worktrees:cleanup:preview', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopWorktreeCleanupPreviewInput(value))
    return worktreeCleanup.preview(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:worktrees:cleanup:confirm', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopWorktreeCleanupConfirmInput(value))
    const result = await worktreeCleanup.confirm(input, new AbortController().signal)
    publishWorktreeChange(result.worktree)
    return result
  })
  ipcMain.handle('desktop:worktrees:recovery:preview', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopWorktreeRecoveryPreviewInput(value))
    return worktreeRecovery.preview(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:worktrees:recovery:confirm', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopWorktreeRecoveryConfirmInput(value))
    const result = await worktreeRecovery.confirm(input, new AbortController().signal)
    publishWorktreeChange(result.worktree)
    return result
  })
  ipcMain.handle('desktop:worktrees:handoff:preview', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopWorktreeHandoffPreflightInput(value))
    return worktreeHandoff.preview(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:worktrees:handoff:confirm', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseDesktopWorktreeHandoffConfirmInput(value))
    return worktreeHandoff.confirm(input, new AbortController().signal)
  })
  ipcMain.handle('desktop:computer:get-state', event => {
    assertTrustedSender(event)
    return computer.snapshot()
  })
  ipcMain.handle('desktop:computer:refresh', async event => {
    assertTrustedSender(event)
    return computer.refresh()
  })
  ipcMain.handle('desktop:computer:select-target', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = parseSelectComputerTargetInput(value)
    if (input === undefined) throw new Error('The computer target request is invalid.')
    return computer.selectTarget(input.targetId)
  })
  ipcMain.handle('desktop:computer:grant-pending-actions', event => {
    assertTrustedSender(event)
    return computer.grantPendingActions()
  })
  ipcMain.handle('desktop:computer:pause-actions', event => {
    assertTrustedSender(event)
    return computer.pauseActions()
  })
  ipcMain.handle('desktop:computer:resume-actions', event => {
    assertTrustedSender(event)
    return computer.resumeActions()
  })
  ipcMain.handle('desktop:computer:revoke-actions', event => {
    assertTrustedSender(event)
    return computer.revokeActions()
  })
  ipcMain.handle('desktop:computer:stop', async event => {
    assertTrustedSender(event)
    return computer.stop()
  })
  ipcMain.handle('desktop:computer:open-permission-settings', async (event, value: unknown) => {
    assertTrustedSender(event)
    if (value !== 'screen-recording' && value !== 'accessibility') {
      throw new Error('The computer permission request is invalid.')
    }
    const pane = value === 'screen-recording' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  })
  ipcMain.handle('desktop:connections:list', event => {
    assertTrustedSender(event)
    return connections.snapshot()
  })
  ipcMain.handle('desktop:connections:connect-api-key', async (event, value: unknown) => {
    assertTrustedSender(event)
    return connections.connectApiKey(validInput(parseConnectApiKeyInput(value)))
  })
  ipcMain.handle('desktop:connections:disconnect', async (event, value: unknown) => {
    assertTrustedSender(event)
    return connections.disconnect(validInput(parseDisconnectConnectionInput(value)))
  })
  ipcMain.handle('desktop:connections:begin-oauth', async (event, value: unknown) => {
    assertTrustedSender(event)
    const input = validInput(parseBeginOAuthInput(value))
    const result = await connections.beginOAuth(input)
    try {
      await shell.openExternal(result.authorizationUrl)
    } catch (error) {
      await connections.cancelOAuth({ requestId: input.requestId, flowId: result.flowId })
      throw error
    }
    return result
  })
  ipcMain.handle('desktop:connections:cancel-oauth', async (event, value: unknown) => {
    assertTrustedSender(event)
    return connections.cancelOAuth(validInput(parseCancelOAuthInput(value)))
  })
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Settings...',
          accelerator: 'CommandOrControl+,',
          click: () => dispatchRendererCommand({ type: 'settings.open' }),
        },
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
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CommandOrControl+N',
          click: () => dispatchRendererCommand({ type: 'session.new' }),
        },
        {
          label: 'Open Project...',
          accelerator: 'CommandOrControl+O',
          click: () => dispatchRendererCommand({ type: 'project.open' }),
        },
        { type: 'separator' },
        { role: 'close' },
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
      label: 'Session',
      submenu: [
        {
          label: 'Stop Current Task',
          accelerator: 'CommandOrControl+.',
          click: () => dispatchRendererCommand({ type: 'session.stop' }),
        },
        { type: 'separator' },
        {
          label: 'Show Harness Log',
          click: () => {
            if (state.logPath !== '') shell.showItemInFolder(state.logPath)
          },
        },
        {
          label: 'Restart Harness',
          click: () => { void restartHarness() },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CommandOrControl+Shift+S',
          click: () => dispatchRendererCommand({ type: 'sidebar.toggle' }),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [
          { type: 'separator' as const },
          { role: 'toggleDevTools' as const },
        ] : []),
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

  const desktopDataPath = join(app.getPath('userData'), 'desktop')
  const encryption = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    backend: () => safeStorageBackend(process.platform, () => safeStorage.getSelectedStorageBackend()),
    encrypt: (plaintext: string) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext: Buffer) => safeStorage.decryptString(ciphertext),
  }
  oauthCoordinator = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(join(desktopDataPath, 'oauth-state.v1.json'), encryption),
    {
      clientId: desktopProtocolRegistered ? process.env.DSH_DESKTOP_LINEAR_CLIENT_ID : undefined,
      clientSecret: process.env.DSH_DESKTOP_LINEAR_CLIENT_SECRET,
    },
  )
  const connections = new ConnectionManager(
    new ConnectionRegistry(join(desktopDataPath, 'connections.v1.json')),
    new CredentialVault(join(desktopDataPath, 'credentials.v1.json'), encryption),
    oauthCoordinator,
  )
  mcpProxy = new McpCredentialProxy(connections)
  await mcpProxy.start()

  computerObserver = new ComputerObserver(
    new NativeComputerHelper(resolveComputerHelper()),
    new ComputerCaptureStore(join(app.getPath('temp'), 'com.dolphinminer.dsh-desktop', 'computer-captures')),
    {
      audit: new ComputerActionAuditStore(join(desktopDataPath, 'computer-actions.v1.json')),
      onChange: snapshot => {
        if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:computer-changed', snapshot)
        }
      },
    },
  )
  await computerObserver.stop()

  const gitService = new GitService()
  const gitTurnAttributions = new GitTurnAttributionService(
    gitService,
    new GitTurnAttributionJournal(join(desktopDataPath, 'git-turn-attributions.v1.json')),
    assertKnownWorkspace,
  )
  const workspaceGit = new WorkspaceGitCapabilityService(gitService, assertActiveWorkspace, gitTurnAttributions)
  const reviewWorkspaceGit = new WorkspaceGitCapabilityService(gitService, assertKnownWorkspace, gitTurnAttributions)
  const mutationWorkspaceGit = new WorkspaceGitCapabilityService(gitService, assertIdleWorkspace)
  const reviewComments = new GitReviewCommentStore(join(desktopDataPath, 'git-review-comments.v1.json'), {
    onChange: event => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:git:comments:changed', event)
      }
    },
  })
  const gitMutations = new GitMutationJournal(join(desktopDataPath, 'git-mutations.v1.json'))
  const gitMutationQueue = new GitRepositoryMutationQueue()
  const worktreeRegistry = new WorktreeRegistry(join(desktopDataPath, 'worktrees.v1.json'))
  const worktreeManager = new WorktreeManager(
    gitService,
    worktreeRegistry,
    join(desktopDataPath, 'worktrees'),
    assertActiveWorkspace,
  )
  const publishWorktreeReconciliation = (
    snapshot: ReturnType<WorktreeManager['snapshot']>,
  ): void => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:worktrees:changed', snapshot)
    }
    harness?.send(createEvent('worktrees.snapshot', snapshot))
  }
  const publishWorktreeChange = (worktree?: WorktreeSummary): void => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:worktrees:changed', worktreeManager.snapshot())
    }
    if (worktree !== undefined) {
      harness?.send(createEvent('worktrees.changed', {
        revision: worktreeRegistry.status().revision,
        worktree,
      }))
    }
  }
  const worktreeCleanup = new WorktreeCleanupController(worktreeManager, {
    isSessionRunning: sessionId => activityTracker.isRunning(sessionId),
    approve: async details => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return false
      const branch = details.branch.startsWith('refs/heads/')
        ? details.branch.slice('refs/heads/'.length)
        : details.branch
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Clean up managed worktree?',
        message: `Remove the checkout for ${branch}?`,
        detail: `${details.worktreePath}\n\nRepository: ${details.repositoryRoot}\n` +
          `Commit: ${details.head}\n\nThe branch is kept. The clean checkout directory is removed.`,
        buttons: ['Cancel', 'Clean Up'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return result.response === 1
    },
  })
  const worktreeRecovery = new WorktreeRecoveryController(worktreeManager, {
    isSessionRunning: sessionId => activityTracker.isRunning(sessionId),
    approve: async details => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return false
      const branch = details.branch.startsWith('refs/heads/')
        ? details.branch.slice('refs/heads/'.length)
        : details.branch
      if (details.action === 'forget-missing') {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Forget missing worktree?',
          message: `Forget the missing checkout for ${branch}?`,
          detail: `${details.worktreePath}\n\nRepository: ${details.repositoryRoot}\n\n` +
            'Git no longer lists this worktree and its checkout path is absent. ' +
            'This removes only the stale DSH Desktop record; it does not delete files or the Git branch.',
          buttons: ['Cancel', 'Forget Record'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        return result.response === 1
      }
      const count = details.changeCount
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Keep interrupted worktree?',
        message: `Cancel the interrupted cleanup for ${branch}?`,
        detail: `${details.worktreePath}\n\nRepository: ${details.repositoryRoot}\n` +
          `Commit: ${details.head}\nCheckout changes: ${String(count)}\n\n` +
          'This keeps the checkout and branch, clears the old removal intent, and does not modify any files.',
        buttons: ['Cancel', 'Keep Worktree'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return result.response === 1
    },
  })
  const worktreeHandoff = new WorktreeHandoffController(
    worktreeManager,
    new WorktreeHandoffJournal(join(desktopDataPath, 'worktree-handoffs.v1.json')),
    gitMutationQueue,
    {
      isSessionRunning: sessionId => activityTracker.isRunning(sessionId),
      isPathRunning: path => activitySnapshot.runningSessionIds.some(sessionId =>
        activitySnapshot.workspacePaths[sessionId] === path),
      approve: async details => {
        if (mainWindow === undefined || mainWindow.isDestroyed()) return false
        const sourceLabel = details.direction === 'local-to-worktree' ? 'local checkout' : 'managed worktree'
        const destinationLabel = details.direction === 'local-to-worktree' ? 'managed worktree' : 'local checkout'
        const count = details.fileCount
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Transfer reviewed changes?',
          message: `Stage ${String(count)} ${count === 1 ? 'file' : 'files'} in the ${destinationLabel}?`,
          detail: `Source (${sourceLabel}): ${details.sourcePath}\n` +
            `Destination (${destinationLabel}): ${details.destinationPath}\n` +
            `Source tree: ${details.sourceTree}\n\n` +
            'The exact reviewed source tree will be applied as staged destination changes. ' +
            'The source checkout is unchanged. Nothing is committed or pushed.',
          buttons: ['Cancel', 'Transfer Changes'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        return result.response === 1
      },
    },
  )

  installMenu()
  installIpcHandlers(
    connections,
    computerObserver,
    reviewWorkspaceGit,
    new GitIndexController(mutationWorkspaceGit, gitMutations, gitMutationQueue),
    new GitCommitController(mutationWorkspaceGit, gitMutations, gitMutationQueue),
    new GitRevertController(mutationWorkspaceGit, gitMutations, gitMutationQueue, {
      approve: async details => {
        if (mainWindow === undefined || mainWindow.isDestroyed()) return false
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Revert unstaged changes?',
          message: `Revert ${details.path}?`,
          detail: `This restores the reviewed file from the Git index in ${details.repositoryRoot}. ` +
            'DSH Desktop cannot recover the discarded unstaged changes.',
          buttons: ['Cancel', 'Revert File'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        return result.response === 1
      },
    }),
    new GitPushController(mutationWorkspaceGit, gitMutations, gitMutationQueue, {
      approve: async details => {
        if (mainWindow === undefined || mainWindow.isDestroyed()) return false
        const count = details.target.ahead
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Push reviewed commits?',
          message: `Push ${String(count)} ${count === 1 ? 'commit' : 'commits'} to ${details.target.remote}?`,
          detail: `${details.target.localRef} -> ${details.target.remoteRef}\n` +
            `${details.target.remoteUrl}\n\nCommit: ${details.target.head}\n` +
            'This is a non-force Push to the configured upstream.',
          buttons: ['Cancel', 'Push'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        return result.response === 1
      },
    }),
    new GitReviewCommentController(reviewWorkspaceGit, reviewComments),
    worktreeManager,
    worktreeCleanup,
    worktreeRecovery,
    worktreeHandoff,
    publishWorktreeChange,
    publishWorktreeReconciliation,
  )

  windowStateStore = new WindowStateStore(join(desktopDataPath, 'window-state.v1.json'), {
    onError: error => console.error('Could not persist the desktop window state.', error),
  })
  const restoredWindowState = await windowStateStore.load(
    screen.getAllDisplays().map(display => display.workArea),
  )
  mainWindow = createWindow(restoredWindowState)
  await showLoadingPage()

  const logPath = join(app.getPath('logs'), 'harness.log')
  const dshHome = join(app.getPath('userData'), 'harness')
  bootstrapDesktopProfile({
    dshHome,
    packageRoot: app.getAppPath(),
    productVersion: app.getVersion(),
  })
  await worktreeManager.reconcile(new AbortController().signal, { orphanUnboundReady: true })
  publishWorktreeChange()
  const capabilityBroker = new DesktopCapabilityBroker(createDesktopCapabilityHandlers({
    isAppFocused: () => mainWindow?.isFocused() ?? false,
    notifications: {
      isSupported: () => Notification.isSupported(),
      show: params => {
        const notification = new Notification({ title: params.title, body: params.body ?? '' })
        notification.on('click', () => {
          if (params.sessionId !== undefined) {
            dispatchRendererCommand({ type: 'session.open', sessionId: params.sessionId })
          } else {
            focusMainWindow()
          }
        })
        notification.show()
      },
    },
    sessionActivity: { report: params => activityTracker.report(params) },
    workspaceFiles: {
      reveal: async (params, signal) => {
        assertActiveWorkspace(params.sessionId, params.workspaceRoot, signal)
        const path = await resolveWorkspaceTarget(params.workspaceRoot, params.path, { operation: 'reveal' })
        assertActiveWorkspace(params.sessionId, params.workspaceRoot, signal)
        shell.showItemInFolder(path)
        return { opened: true, path }
      },
      open: async (params, signal) => {
        assertActiveWorkspace(params.sessionId, params.workspaceRoot, signal)
        const path = await resolveWorkspaceTarget(params.workspaceRoot, params.path, { operation: 'open' })
        assertActiveWorkspace(params.sessionId, params.workspaceRoot, signal)
        const error = await shell.openPath(path)
        if (error !== '') throw new Error(`The operating system could not open this file: ${error}`)
        return { opened: true, path }
      },
    },
    git: {
      discover: (params, signal) => workspaceGit.discover(params, signal),
      status: (params, signal) => workspaceGit.status(params, signal),
      review: (params, signal) => workspaceGit.review(params, signal),
      reportTurnBoundary: (params, signal) => gitTurnAttributions.reportBoundary(params, signal),
    },
    worktrees: {
      snapshot: () => worktreeManager.snapshot(),
      provision: async (params, signal) => {
        const result = await worktreeManager.provision(params, signal)
        const summary = summarizeWorktreeRecord(result.record)
        publishWorktreeChange(summary)
        if (result.created && result.record.worktreePath !== undefined) {
          const command: DesktopRendererCommand = {
            type: 'worktree.open',
            recordId: result.record.id,
            path: result.record.worktreePath,
          }
          setImmediate(() => {
            dispatchRendererCommand(command)
          })
        }
        return summary
      },
      reportSessionBinding: async (params, signal) => {
        const record = await worktreeManager.bindSession(params, signal)
        if (record === undefined) return { managed: false }
        const summary = summarizeWorktreeRecord(record)
        publishWorktreeChange(summary)
        return { managed: true, worktree: summary }
      },
    },
    computer: {
      getPermissions: signal => computerObserver!.getPermissions(signal),
      listApplications: signal => computerObserver!.listApplications(signal),
      observe: (sessionId, signal) => computerObserver!.observe(sessionId, signal),
      act: (params, signal) => {
        assertActiveSession(params.sessionId, signal)
        return computerObserver!.act(params, signal)
      },
    },
    connections: {
      snapshot: () => connections.snapshot(),
      resolveMcpTransport: (connectionId, signal) =>
        mcpProxy!.resolveMcpTransport(connectionId, signal),
      reportStatus: params => connections.reportStatus(params),
    },
  }), { requestTimeoutMs: 70_000 })
  connections.onChange(snapshot => {
    for (const connection of snapshot.connections) {
      if (connection.status === 'disconnected') mcpProxy?.revoke(connection.id)
    }
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:connections-changed', snapshot)
    }
    harness?.send(createEvent('connections.changed', { revision: snapshot.revision }))
  })
  oauthCoordinator.setCompletionHandler(async completion => {
    await connections.completeOAuth(completion)
  })
  for (const link of pendingOAuthLinks.splice(0)) receiveOAuthLink(link)
  for (const argument of process.argv) receiveDesktopLink(argument)
  harness = new HarnessService({
    dshBin: resolveDshBin(),
    dshHome,
    cwd: homedir(),
    logPath,
    nodeExecutable: process.execPath,
    profileName: 'desktop',
    capabilityBroker,
    onDisconnect: () => {
      activityTracker.clear()
      connections.hostDisconnected()
      void computerObserver?.stop().catch(() => undefined)
    },
    onUnexpectedFailure: () => harnessRecovery?.handleUnexpectedFailure(),
    onState: publishState,
  })
  harnessRecovery = new HarnessRecoveryController({
    start: launchHarness,
    onSchedule: publishRecoverySchedule,
    onExhausted: publishRecoveryExhausted,
    onStartError: error => {
      publishState({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        logPath,
      })
    },
  })

  await harnessRecovery.restartNow()
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
  harnessRecovery?.stop()
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    windowStateStore?.schedule(captureWindowState(mainWindow))
  }
  const stopServices = Promise.all([
    harness?.stop() ?? Promise.resolve(),
    mcpProxy?.stop() ?? Promise.resolve(),
    computerObserver?.dispose() ?? Promise.resolve(),
    windowStateStore?.flush() ?? Promise.resolve(),
  ])
  void stopServices
    .catch(error => {
      console.error('Could not stop Harness cleanly.', error)
    })
    .finally(() => {
      oauthCoordinator?.dispose()
      shutdownComplete = true
      app.quit()
    })
})

app.on('window-all-closed', () => app.quit())
