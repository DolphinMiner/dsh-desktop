import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'

import type {
  BrowserClickParams,
  BrowserDownloadParams,
  BrowserDownloadResult,
  BrowserFrame,
  BrowserHistoryEntry,
  BrowserNavigateParams,
  BrowserObservation,
  BrowserObserveParams,
  BrowserSelectParams,
  BrowserScrollParams,
  BrowserScreenshotParams,
  BrowserSettings,
  BrowserState,
  BrowserTabParams,
  BrowserTabsParams,
  BrowserTabsSnapshot,
  BrowserTypeParams,
  BrowserUploadParams,
  BrowserUiKeyboardInput,
  BrowserUiFindInput,
  BrowserUiNavigateInput,
  BrowserUiOpenManagementInput,
  BrowserUiPointerInput,
  BrowserUiScrollInput,
  BrowserUiViewportInput,
  BrowserUiZoomInput,
  UpdateBrowserSettingsInput,
} from '@dolphinminer/dsh-desktop-protocol'
import {
  BROWSER_DOWNLOAD_VERSION,
  BROWSER_OBSERVATION_VERSION,
  BROWSER_TABS_VERSION,
  isDesktopProtocolErrorCode,
} from '@dolphinminer/dsh-desktop-protocol'

import { BrowserStore, DEFAULT_BROWSER_SETTINGS } from './browser-store'
import {
  BrowserEngine,
  BrowserDownloadFile,
  BrowserEngineState,
  BrowserUploadFile,
  ControlledBrowserError,
  PlaywrightBrowserLaunchOptions,
} from './playwright-browser'

const MAX_COMPLETED_ACTIONS = 256
const MAX_HISTORY_ENTRIES = 500
const BROWSER_MANAGEMENT_URLS = {
  import: 'chrome://settings/importData',
  passwords: 'chrome://password-manager/passwords',
  contacts: 'chrome://settings/contactInfo',
  downloads: 'chrome://downloads',
  history: 'chrome://history',
} as const

interface BrowserControllerOptions {
  profilePath: string
  executablePath?: string
  loadUploadFiles: (
    params: BrowserUploadParams,
    signal: AbortSignal,
  ) => Promise<readonly BrowserUploadFile[]>
  saveDownload: (
    params: BrowserDownloadParams,
    file: BrowserDownloadFile,
    signal: AbortSignal,
  ) => Promise<{ path: string }>
  now?: () => Date
  onChange?: (state: BrowserState) => void
  onFrame?: (frame: BrowserFrame | undefined) => void
}

interface LatestObservation {
  observation: BrowserObservation
  sessionId?: string
}

interface CompletedAction {
  fingerprint: string
  observation: BrowserObservation
}

interface CompletedDownload {
  fingerprint: string
  result: BrowserDownloadResult
}

function cloneSettings(settings: BrowserSettings): BrowserSettings {
  return { ...settings }
}

function cloneObservation(observation: BrowserObservation): BrowserObservation {
  return { ...observation }
}

function cloneDownloadResult(result: BrowserDownloadResult): BrowserDownloadResult {
  return { ...result, observation: cloneObservation(result.observation) }
}

function cloneFrame(frame: BrowserFrame): BrowserFrame {
  return { ...frame, data: frame.data.slice() }
}

function cloneHistory(history: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  return history.map(entry => ({ ...entry }))
}

function emptyEngineState(): BrowserEngineState {
  return { tabs: [], canGoBack: false, canGoForward: false }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.slice(0, 1_000)
  return 'The controlled browser operation failed.'
}

function controlledBrowserDisabled(): never {
  throw new ControlledBrowserError('PERMISSION_DENIED', 'Enable Browser in Settings before using it.')
}

function sameBrowserManagementUrl(actual: string, expected: string): boolean {
  return actual === expected || actual === `${expected}/`
}

export function isLocalBrowserUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local')
  } catch {
    return false
  }
}

export class BrowserController {
  private revision = 0
  private settings = cloneSettings(DEFAULT_BROWSER_SETTINGS)
  private history: BrowserHistoryEntry[] = []
  private runtimeStatus: BrowserState['runtimeStatus'] = 'stopped'
  private engineState = emptyEngineState()
  private latest?: LatestObservation
  private latestFrame?: BrowserFrame
  private statusMessage?: string
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly completedActions = new Map<string, CompletedAction>()
  private readonly completedDownloads = new Map<string, CompletedDownload>()
  private readonly now: () => Date
  private readonly onChange: (state: BrowserState) => void
  private readonly onFrame: (frame: BrowserFrame | undefined) => void

  constructor(
    private readonly store: BrowserStore,
    private readonly engine: BrowserEngine,
    private readonly options: BrowserControllerOptions,
  ) {
    this.now = options.now ?? (() => new Date())
    this.onChange = options.onChange ?? (() => undefined)
    this.onFrame = options.onFrame ?? (() => undefined)
  }

  snapshot(): BrowserState {
    return {
      revision: this.revision,
      settings: cloneSettings(this.settings),
      runtimeStatus: this.runtimeStatus,
      tabs: this.engineState.tabs.map(tab => ({ ...tab })),
      ...(this.engineState.activeTabId === undefined ? {} : { activeTabId: this.engineState.activeTabId }),
      canGoBack: this.engineState.canGoBack,
      canGoForward: this.engineState.canGoForward,
      ...(this.engineState.zoomFactor === undefined ? {} : { zoomFactor: this.engineState.zoomFactor }),
      historyCount: this.history.length,
      ...(this.latest === undefined ? {} : {
        lastObservation: {
          snapshotId: this.latest.observation.snapshotId,
          tabId: this.latest.observation.tabId,
          observedAt: this.latest.observation.observedAt,
          url: this.latest.observation.url,
          title: this.latest.observation.title,
        },
      }),
      ...(this.statusMessage === undefined ? {} : { statusMessage: this.statusMessage }),
    }
  }

  start(): Promise<BrowserState> {
    return this.exclusive(async () => {
      this.assertAlive()
      const loaded = this.store.load()
      this.settings = cloneSettings(loaded.settings)
      this.history = cloneHistory(loaded.history)
      this.statusMessage = loaded.recovered
        ? 'Browser settings were reset because the saved file could not be read.'
        : undefined
      this.publish()
      if (this.settings.enabled) {
        await this.ensureRunning(new AbortController().signal).catch(() => undefined)
      }
      return this.snapshot()
    })
  }

  update(input: UpdateBrowserSettingsInput): Promise<BrowserState> {
    return this.exclusive(async () => {
      this.assertAlive()
      const previous = this.settings
      const next: BrowserSettings = { ...previous, ...input, storageMode: 'persistent' }
      this.store.save(next, this.history)
      this.settings = next
      this.statusMessage = undefined
      const restart = previous.storageMode !== next.storageMode
      if (!next.enabled || restart) await this.stopRuntime()
      if (next.enabled) await this.ensureRunning(new AbortController().signal)
      this.publish()
      return this.snapshot()
    })
  }

  listHistory(): BrowserHistoryEntry[] {
    return cloneHistory(this.history)
  }

  clearHistory(): Promise<BrowserState> {
    return this.exclusive(async () => {
      this.assertAlive()
      this.history = []
      this.store.save(this.settings, this.history)
      this.publish()
      return this.snapshot()
    })
  }

  clearData(): Promise<BrowserState> {
    return this.exclusive(async () => {
      this.assertAlive()
      this.history = []
      this.store.save(this.settings, this.history)
      await this.stopRuntime()
      await rm(this.options.profilePath, { force: true, recursive: true })
      if (this.settings.enabled) await this.ensureRunning(new AbortController().signal)
      this.statusMessage = undefined
      this.publish()
      return this.snapshot()
    })
  }

  stop(): Promise<BrowserState> {
    return this.update({ enabled: false })
  }

  navigate(params: BrowserNavigateParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      this.assertEnabled()
      await this.ensureRunning(signal)
      await this.engine.navigate(params.url, params.newTab ?? false, signal)
      return this.observeCurrent(
        params.sessionId,
        undefined,
        this.settings.screenshotPolicy !== 'never',
        true,
        signal,
      )
    }))
  }

  observe(params: BrowserObserveParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(async () => {
      this.assertEnabled()
      await this.ensureRunning(signal)
      return this.observeCurrent(
        params.sessionId,
        params.tabId,
        this.settings.screenshotPolicy !== 'never',
        false,
        signal,
      )
    })
  }

  screenshot(params: BrowserScreenshotParams): Promise<BrowserFrame> {
    return this.exclusive(async () => {
      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      const frame = this.latestFrame
      if (frame === undefined || frame.snapshotId !== params.snapshotId || frame.tabId !== tabId) {
        throw new ControlledBrowserError('NOT_FOUND', 'The latest browser observation has no screenshot.')
      }
      return cloneFrame(frame)
    })
  }

  tabs(_params: BrowserTabsParams, signal: AbortSignal): Promise<BrowserTabsSnapshot> {
    return this.exclusive(async () => {
      this.assertEnabled()
      await this.ensureRunning(signal)
      this.engineState = await this.engine.state()
      this.publish()
      const activeTabId = this.engineState.activeTabId
      if (activeTabId === undefined) {
        throw new ControlledBrowserError('NOT_FOUND', 'The controlled browser has no active tab.')
      }
      return {
        version: BROWSER_TABS_VERSION,
        revision: this.revision,
        activeTabId,
        tabs: this.engineState.tabs.map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          loading: tab.loading,
        })),
      }
    })
  }

  tab(params: BrowserTabParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      this.assertEnabled()
      await this.ensureRunning(signal)
      if (params.revision !== this.revision) {
        throw new ControlledBrowserError(
          'TARGET_CHANGED',
          'The browser tabs changed. List the current tabs and try again.',
        )
      }
      if (params.action === 'new') await this.engine.newTab()
      else if (params.action === 'activate') await this.engine.activate(params.tabId!)
      else await this.engine.closeTab(params.tabId!)
      return this.observeCurrent(
        params.sessionId,
        params.action === 'activate' ? params.tabId : undefined,
        this.settings.screenshotPolicy !== 'never',
        false,
        signal,
      )
    }))
  }

  click(params: BrowserClickParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      await this.engine.click(tabId, params.role, params.name, params.exact ?? true, signal)
      return this.observeCurrent(
        params.sessionId,
        tabId,
        this.settings.screenshotPolicy === 'always',
        true,
        signal,
      )
    }))
  }

  type(params: BrowserTypeParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      await this.engine.type(tabId, params.role, params.name, params.text, params.submit ?? false, signal)
      return this.observeCurrent(
        params.sessionId,
        tabId,
        this.settings.screenshotPolicy === 'always',
        true,
        signal,
      )
    }))
  }

  select(params: BrowserSelectParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      await this.engine.select(tabId, params.name, params.option, params.exact ?? true, signal)
      return this.observeCurrent(
        params.sessionId,
        tabId,
        this.settings.screenshotPolicy === 'always',
        true,
        signal,
      )
    }))
  }

  upload(
    params: BrowserUploadParams,
    signal: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      const files = await this.options.loadUploadFiles(params, signal)
      this.invalidateLatestObservation()
      await this.engine.upload(tabId, params.name, files, params.exact ?? true, signal)
      return this.observeCurrent(
        params.sessionId,
        tabId,
        this.settings.screenshotPolicy === 'always',
        true,
        signal,
      )
    }))
  }

  download(params: BrowserDownloadParams, signal: AbortSignal): Promise<BrowserDownloadResult> {
    return this.exclusive(async () => {
      const fingerprint = JSON.stringify(params)
      const previous = this.completedDownloads.get(params.actionId)
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new ControlledBrowserError('DUPLICATE_REQUEST', 'The browser action ID was reused with different input.')
        }
        return cloneDownloadResult(previous.result)
      }

      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      this.invalidateLatestObservation()
      const file = await this.engine.download(tabId, params.role, params.name, params.exact ?? true, signal)
      try {
        const saved = await this.options.saveDownload(params, file, signal)
        const observation = await this.observeCurrent(
          params.sessionId,
          tabId,
          this.settings.screenshotPolicy === 'always',
          true,
          signal,
        )
        const result: BrowserDownloadResult = {
          version: BROWSER_DOWNLOAD_VERSION,
          actionId: params.actionId,
          previousSnapshotId: params.snapshotId,
          path: saved.path,
          suggestedFilename: file.suggestedFilename,
          bytes: file.data.byteLength,
          observation,
        }
        this.completedDownloads.set(params.actionId, {
          fingerprint,
          result: cloneDownloadResult(result),
        })
        while (this.completedDownloads.size > MAX_COMPLETED_ACTIONS) {
          const oldest = this.completedDownloads.keys().next().value as string | undefined
          if (oldest === undefined) break
          this.completedDownloads.delete(oldest)
        }
        return result
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error &&
          isDesktopProtocolErrorCode(error.code)
          ? error.code
          : 'DESKTOP_UNAVAILABLE'
        throw new ControlledBrowserError(code, failureMessage(error), true)
      }
    })
  }

  scroll(params: BrowserScrollParams, signal: AbortSignal): Promise<BrowserObservation> {
    return this.exclusive(() => this.once(params.actionId, params, async () => {
      const tabId = this.assertLatest(params.sessionId, params.snapshotId)
      await this.engine.scroll(tabId, params.deltaX, params.deltaY, signal)
      return this.observeCurrent(
        params.sessionId,
        tabId,
        this.settings.screenshotPolicy === 'always',
        false,
        signal,
      )
    }))
  }

  navigateFromUi(input: BrowserUiNavigateInput): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.navigate(input.url, input.newTab ?? false, signal)
      await this.observeCurrent(undefined, undefined, true, true, signal)
    })
  }

  openManagement(input: BrowserUiOpenManagementInput): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      const url = BROWSER_MANAGEMENT_URLS[input.page]
      const current = await this.engine.state()
      const existing = current.tabs.find(tab => sameBrowserManagementUrl(tab.url, url))
      if (existing === undefined) await this.engine.navigate(url, true, signal)
      else await this.engine.activate(existing.id)
      await this.observeCurrent(undefined, existing?.id, true, false, signal)
    })
  }

  activateTab(tabId: string): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.activate(tabId)
      await this.observeCurrent(undefined, tabId, true, false, signal)
    })
  }

  newTab(): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.newTab()
      await this.observeCurrent(undefined, undefined, true, false, signal)
    })
  }

  closeTab(tabId: string): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.closeTab(tabId)
      await this.observeCurrent(undefined, undefined, true, false, signal)
    })
  }

  goBack(): Promise<BrowserState> {
    return this.navigateHistory(signal => this.engine.goBack(signal))
  }

  goForward(): Promise<BrowserState> {
    return this.navigateHistory(signal => this.engine.goForward(signal))
  }

  reload(): Promise<BrowserState> {
    return this.navigateHistory(signal => this.engine.reload(signal))
  }

  findFromUi(input: BrowserUiFindInput): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.find(input.query, input.forward ?? true, signal)
      await this.observeCurrent(undefined, undefined, true, false, signal)
    })
  }

  zoomFromUi(input: BrowserUiZoomInput): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.setZoom(input.factor)
      await this.observeCurrent(undefined, undefined, true, false, signal)
    })
  }

  captureForUi(): Promise<BrowserFrame> {
    return this.exclusive(async () => {
      this.assertEnabled()
      const signal = new AbortController().signal
      await this.ensureRunning(signal)
      await this.observeCurrent(undefined, undefined, true, false, signal)
      if (this.latestFrame === undefined) {
        throw new ControlledBrowserError('NOT_FOUND', 'The current browser page has no screenshot.')
      }
      return cloneFrame(this.latestFrame)
    })
  }

  printForUi(): Promise<Buffer> {
    return this.exclusive(async () => {
      this.assertEnabled()
      const signal = new AbortController().signal
      await this.ensureRunning(signal)
      return this.engine.printToPdf(signal)
    })
  }

  refreshFrame(): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.observeCurrent(undefined, undefined, true, false, signal)
    })
  }

  resizeViewport(input: BrowserUiViewportInput): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await this.engine.resizeViewport(input.pixelWidth, input.pixelHeight)
      await this.observeCurrent(undefined, undefined, true, false, signal)
    })
  }

  pointerFromUi(input: BrowserUiPointerInput): Promise<BrowserState> {
    return this.uiSnapshotOperation(input, async (tabId, signal) => {
      await this.engine.clickAt(
        tabId,
        input.normalizedX,
        input.normalizedY,
        input.button ?? 'left',
        signal,
      )
    }, true)
  }

  scrollFromUi(input: BrowserUiScrollInput): Promise<BrowserState> {
    return this.uiSnapshotOperation(input, async (tabId, signal) => {
      await this.engine.scrollAt(
        tabId,
        input.normalizedX,
        input.normalizedY,
        input.deltaX,
        input.deltaY,
        signal,
      )
    }, false)
  }

  keyboardFromUi(input: BrowserUiKeyboardInput): Promise<BrowserState> {
    return this.uiSnapshotOperation(input, async (tabId, signal) => {
      await this.engine.keyboard(tabId, input.actions, signal)
    }, true)
  }

  shouldOpenControlled(url: string): boolean {
    return this.settings.enabled &&
      (isLocalBrowserUrl(url) ? this.settings.localUrlTarget : this.settings.webUrlTarget) === 'controlled'
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.queue.catch(() => undefined)
    await this.stopRuntime()
  }

  private navigateHistory(operation: (signal: AbortSignal) => Promise<void>): Promise<BrowserState> {
    return this.uiOperation(async signal => {
      await operation(signal)
      await this.observeCurrent(undefined, undefined, true, true, signal)
    })
  }

  private uiOperation(operation: (signal: AbortSignal) => Promise<void>): Promise<BrowserState> {
    return this.exclusive(async () => {
      this.assertEnabled()
      const signal = new AbortController().signal
      await this.ensureRunning(signal)
      await operation(signal)
      return this.snapshot()
    })
  }

  private uiSnapshotOperation(
    input: { snapshotId: string; tabId: string },
    operation: (tabId: string, signal: AbortSignal) => Promise<void>,
    recordHistory: boolean,
  ): Promise<BrowserState> {
    return this.exclusive(async () => {
      this.assertEnabled()
      const signal = new AbortController().signal
      await this.ensureRunning(signal)
      const tabId = this.assertUiSnapshot(input.snapshotId, input.tabId)
      await operation(tabId, signal)
      await this.observeCurrent(undefined, tabId, true, recordHistory, signal)
      return this.snapshot()
    })
  }

  private async ensureRunning(signal: AbortSignal): Promise<void> {
    if (this.runtimeStatus === 'ready') return
    this.runtimeStatus = 'starting'
    this.statusMessage = undefined
    this.publish()
    try {
      const options: PlaywrightBrowserLaunchOptions = {
        storageMode: this.settings.storageMode,
        profilePath: this.options.profilePath,
        ...(this.options.executablePath === undefined ? {} : { executablePath: this.options.executablePath }),
      }
      await this.engine.start(options, signal)
      this.runtimeStatus = 'ready'
      this.engineState = await this.engine.state()
      this.statusMessage = undefined
      this.publish()
    } catch (error) {
      this.runtimeStatus = 'error'
      this.engineState = emptyEngineState()
      this.statusMessage = failureMessage(error)
      this.publish()
      throw error
    }
  }

  private async stopRuntime(): Promise<void> {
    await this.engine.stop()
    this.runtimeStatus = 'stopped'
    this.engineState = emptyEngineState()
    this.latest = undefined
    this.latestFrame = undefined
    this.completedActions.clear()
    this.completedDownloads.clear()
    this.onFrame(undefined)
  }

  private async observeCurrent(
    sessionId: string | undefined,
    tabId: string | undefined,
    captureScreenshot: boolean,
    recordHistory: boolean,
    signal: AbortSignal,
  ): Promise<BrowserObservation> {
    const observed = await this.engine.observe(tabId, captureScreenshot, signal)
    const snapshotId = randomUUID()
    const observedAt = this.now().toISOString()
    const observation: BrowserObservation = {
      version: BROWSER_OBSERVATION_VERSION,
      snapshotId,
      tabId: observed.tabId,
      observedAt,
      url: observed.url,
      title: observed.title,
      ariaSnapshot: observed.ariaSnapshot,
      truncated: observed.truncated,
      screenshotCaptured: observed.screenshot !== undefined,
    }
    this.latest = { observation, ...(sessionId === undefined ? {} : { sessionId }) }
    this.engineState = await this.engine.state()
    if (recordHistory) this.recordHistory(observation)
    if (observed.screenshot !== undefined) {
      const frame: BrowserFrame = {
        snapshotId,
        tabId: observed.tabId,
        capturedAt: observedAt,
        mediaType: 'image/jpeg',
        pixelWidth: observed.screenshot.pixelWidth,
        pixelHeight: observed.screenshot.pixelHeight,
        data: observed.screenshot.data.slice(),
      }
      this.latestFrame = frame
      this.onFrame(cloneFrame(frame))
    } else {
      this.latestFrame = undefined
      this.onFrame(undefined)
    }
    this.publish()
    return cloneObservation(observation)
  }

  private recordHistory(observation: BrowserObservation): void {
    if (!observation.url.startsWith('http://') && !observation.url.startsWith('https://')) return
    const first = this.history[0]
    if (first?.url === observation.url && first.title === observation.title) return
    this.history.unshift({
      id: randomUUID(),
      url: observation.url,
      title: observation.title,
      visitedAt: observation.observedAt,
    })
    this.history = this.history.slice(0, MAX_HISTORY_ENTRIES)
    this.store.save(this.settings, this.history)
  }

  private assertLatest(sessionId: string, snapshotId: string): string {
    this.assertEnabled()
    const latest = this.latest
    if (latest === undefined || latest.sessionId !== sessionId ||
      latest.observation.snapshotId !== snapshotId) {
      throw new ControlledBrowserError(
        'TARGET_CHANGED',
        'The browser page changed after that observation. Observe the current page and try again.',
      )
    }
    return latest.observation.tabId
  }

  private assertUiSnapshot(snapshotId: string, tabId: string): string {
    const latest = this.latest?.observation
    if (latest === undefined || latest.snapshotId !== snapshotId || latest.tabId !== tabId ||
      this.engineState.activeTabId !== tabId) {
      throw new ControlledBrowserError(
        'TARGET_CHANGED',
        'The Browser preview changed. Wait for the current page and try again.',
      )
    }
    return tabId
  }

  private invalidateLatestObservation(): void {
    this.latest = undefined
    this.latestFrame = undefined
    this.onFrame(undefined)
    this.publish()
  }

  private async once<T extends { actionId: string }>(
    actionId: string,
    input: T,
    operation: () => Promise<BrowserObservation>,
  ): Promise<BrowserObservation> {
    const fingerprint = JSON.stringify(input)
    const previous = this.completedActions.get(actionId)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new ControlledBrowserError('DUPLICATE_REQUEST', 'The browser action ID was reused with different input.')
      }
      return cloneObservation(previous.observation)
    }
    const observation = await operation()
    this.completedActions.set(actionId, { fingerprint, observation: cloneObservation(observation) })
    while (this.completedActions.size > MAX_COMPLETED_ACTIONS) {
      const oldest = this.completedActions.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.completedActions.delete(oldest)
    }
    return observation
  }

  private assertEnabled(): void {
    this.assertAlive()
    if (!this.settings.enabled) controlledBrowserDisabled()
  }

  private assertAlive(): void {
    if (this.disposed) throw new ControlledBrowserError('DESKTOP_UNAVAILABLE', 'The controlled browser has stopped.')
  }

  private publish(): void {
    this.revision += 1
    this.onChange(this.snapshot())
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
