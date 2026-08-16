export const BROWSER_OBSERVATION_VERSION = 1 as const
export const BROWSER_TABS_VERSION = 1 as const
export const BROWSER_DOWNLOAD_VERSION = 1 as const

export type BrowserUrlTarget = 'system' | 'controlled'
export type BrowserScreenshotPolicy = 'always' | 'on-demand' | 'never'
export type BrowserStorageMode = 'isolated' | 'persistent'
export type BrowserRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'error'

export interface BrowserSettings {
  enabled: boolean
  webUrlTarget: BrowserUrlTarget
  localUrlTarget: BrowserUrlTarget
  screenshotPolicy: BrowserScreenshotPolicy
  storageMode: BrowserStorageMode
}

export interface UpdateBrowserSettingsInput {
  enabled?: boolean
  webUrlTarget?: BrowserUrlTarget
  localUrlTarget?: BrowserUrlTarget
  screenshotPolicy?: BrowserScreenshotPolicy
}

export interface BrowserTabSummary {
  id: string
  url: string
  title: string
  loading: boolean
}

export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: string
}

export interface BrowserObservationSummary {
  snapshotId: string
  tabId: string
  observedAt: string
  url: string
  title: string
}

export interface BrowserState {
  revision: number
  settings: BrowserSettings
  runtimeStatus: BrowserRuntimeStatus
  tabs: BrowserTabSummary[]
  activeTabId?: string
  canGoBack: boolean
  canGoForward: boolean
  historyCount: number
  lastObservation?: BrowserObservationSummary
  statusMessage?: string
}

export interface BrowserFrame {
  snapshotId: string
  tabId: string
  capturedAt: string
  mediaType: 'image/jpeg'
  pixelWidth: number
  pixelHeight: number
  data: Uint8Array
}

export interface BrowserObservation extends BrowserObservationSummary {
  version: typeof BROWSER_OBSERVATION_VERSION
  ariaSnapshot: string
  truncated: boolean
  screenshotCaptured: boolean
}

export interface BrowserTabsSnapshot {
  version: typeof BROWSER_TABS_VERSION
  revision: number
  activeTabId: string
  tabs: BrowserTabSummary[]
}

export interface BrowserNavigateParams {
  actionId: string
  sessionId: string
  url: string
  newTab?: boolean
}

export interface BrowserObserveParams {
  sessionId: string
  tabId?: string
}

export interface BrowserScreenshotParams {
  sessionId: string
  snapshotId: string
}

export interface BrowserTabsParams {
  sessionId: string
}

export type BrowserTabAction = 'new' | 'activate' | 'close'

export interface BrowserTabParams {
  actionId: string
  sessionId: string
  revision: number
  action: BrowserTabAction
  tabId?: string
}

export interface BrowserClickParams {
  actionId: string
  sessionId: string
  snapshotId: string
  role: string
  name: string
  exact?: boolean
}

export interface BrowserTypeParams {
  actionId: string
  sessionId: string
  snapshotId: string
  role: string
  name: string
  text: string
  submit?: boolean
}

export interface BrowserSelectParams {
  actionId: string
  sessionId: string
  snapshotId: string
  name: string
  option: string
  exact?: boolean
}

export interface BrowserUploadParams {
  actionId: string
  sessionId: string
  workspaceRoot: string
  snapshotId: string
  name: string
  paths: string[]
  exact?: boolean
}

export interface BrowserDownloadParams {
  actionId: string
  sessionId: string
  workspaceRoot: string
  snapshotId: string
  role: string
  name: string
  path: string
  exact?: boolean
}

export interface BrowserDownloadResult {
  version: typeof BROWSER_DOWNLOAD_VERSION
  actionId: string
  previousSnapshotId: string
  path: string
  suggestedFilename: string
  bytes: number
  observation: BrowserObservation
}

export interface BrowserScrollParams {
  actionId: string
  sessionId: string
  snapshotId: string
  deltaX: number
  deltaY: number
}

export interface BrowserUiNavigateInput {
  url: string
  newTab?: boolean
}

export type BrowserManagementPage = 'import' | 'passwords' | 'contacts'

export interface BrowserUiOpenManagementInput {
  page: BrowserManagementPage
}

export interface BrowserUiTabInput {
  tabId: string
}

export interface BrowserUiViewportInput {
  pixelWidth: number
  pixelHeight: number
}

export interface BrowserUiPointerInput {
  snapshotId: string
  tabId: string
  normalizedX: number
  normalizedY: number
  button?: 'left' | 'right'
}

export interface BrowserUiScrollInput {
  snapshotId: string
  tabId: string
  normalizedX: number
  normalizedY: number
  deltaX: number
  deltaY: number
}

export type BrowserUiKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

export type BrowserUiKeyboardAction =
  | { kind: 'text'; text: string }
  | { kind: 'press'; key: string; modifiers?: BrowserUiKeyModifier[] }

export interface BrowserUiKeyboardInput {
  snapshotId: string
  tabId: string
  actions: BrowserUiKeyboardAction[]
}

const MAX_ID_LENGTH = 256
const MAX_URL_LENGTH = 4_096
const MAX_TITLE_LENGTH = 512
const MAX_STATUS_LENGTH = 1_000
const MAX_ARIA_LENGTH = 60_000
const MAX_TEXT_LENGTH = 8_192
const MAX_ROLE_LENGTH = 64
const MAX_NAME_LENGTH = 1_000
const MAX_ITEMS = 1_000
const MAX_TABS = 32
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_EDGE = 8_192
const MAX_SCROLL_DELTA = 20_000
const MAX_UI_KEYBOARD_ACTIONS = 64
const MAX_UPLOAD_FILES = 8
const MAX_PATH_LENGTH = 4_096
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

const BROWSER_PRESS_KEYS = new Set([
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'Tab',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
])

const BROWSER_KEY_MODIFIERS = new Set<BrowserUiKeyModifier>(['Alt', 'Control', 'Meta', 'Shift'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function validDate(value: unknown): value is string {
  return isString(value, 64) && !Number.isNaN(Date.parse(value))
}

function urlTarget(value: unknown): value is BrowserUrlTarget {
  return value === 'system' || value === 'controlled'
}

function screenshotPolicy(value: unknown): value is BrowserScreenshotPolicy {
  return value === 'always' || value === 'on-demand' || value === 'never'
}

function storageMode(value: unknown): value is BrowserStorageMode {
  return value === 'isolated' || value === 'persistent'
}

export function parseControlledBrowserUrl(value: unknown): string | undefined {
  if (!isString(value, MAX_URL_LENGTH)) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.toString()
}

export function parseBrowserSettings(value: unknown): BrowserSettings | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['enabled', 'webUrlTarget', 'localUrlTarget', 'screenshotPolicy', 'storageMode'],
  ) || typeof value.enabled !== 'boolean' || !urlTarget(value.webUrlTarget) ||
    !urlTarget(value.localUrlTarget) || !screenshotPolicy(value.screenshotPolicy) ||
    !storageMode(value.storageMode)) return undefined
  return {
    enabled: value.enabled,
    webUrlTarget: value.webUrlTarget,
    localUrlTarget: value.localUrlTarget,
    screenshotPolicy: value.screenshotPolicy,
    storageMode: value.storageMode,
  }
}

export function parseUpdateBrowserSettingsInput(value: unknown): UpdateBrowserSettingsInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['enabled', 'webUrlTarget', 'localUrlTarget', 'screenshotPolicy'],
  ) || (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
    (value.webUrlTarget !== undefined && !urlTarget(value.webUrlTarget)) ||
    (value.localUrlTarget !== undefined && !urlTarget(value.localUrlTarget)) ||
    (value.screenshotPolicy !== undefined && !screenshotPolicy(value.screenshotPolicy)) ||
    !Object.values(value).some(item => item !== undefined)) return undefined
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.webUrlTarget === undefined ? {} : { webUrlTarget: value.webUrlTarget }),
    ...(value.localUrlTarget === undefined ? {} : { localUrlTarget: value.localUrlTarget }),
    ...(value.screenshotPolicy === undefined ? {} : { screenshotPolicy: value.screenshotPolicy }),
  }
}

function parseTab(value: unknown): BrowserTabSummary | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'url', 'title', 'loading']) ||
    !isString(value.id, MAX_ID_LENGTH) || !isString(value.url, MAX_URL_LENGTH, true) ||
    !isString(value.title, MAX_TITLE_LENGTH, true) || typeof value.loading !== 'boolean') return undefined
  return { id: value.id, url: value.url, title: value.title, loading: value.loading }
}

function parseObservationSummary(value: unknown): BrowserObservationSummary | undefined {
  if (!isRecord(value) || !isString(value.snapshotId, MAX_ID_LENGTH) ||
    !isString(value.tabId, MAX_ID_LENGTH) || !validDate(value.observedAt) ||
    !isString(value.url, MAX_URL_LENGTH, true) || !isString(value.title, MAX_TITLE_LENGTH, true)) {
    return undefined
  }
  return {
    snapshotId: value.snapshotId,
    tabId: value.tabId,
    observedAt: value.observedAt,
    url: value.url,
    title: value.title,
  }
}

export function parseBrowserState(value: unknown): BrowserState | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    (value.runtimeStatus !== 'stopped' && value.runtimeStatus !== 'starting' &&
      value.runtimeStatus !== 'ready' && value.runtimeStatus !== 'error') ||
    !Array.isArray(value.tabs) || value.tabs.length > MAX_TABS ||
    typeof value.canGoBack !== 'boolean' || typeof value.canGoForward !== 'boolean' ||
    !Number.isSafeInteger(value.historyCount) || Number(value.historyCount) < 0 ||
    (value.activeTabId !== undefined && !isString(value.activeTabId, MAX_ID_LENGTH)) ||
    (value.statusMessage !== undefined && !isString(value.statusMessage, MAX_STATUS_LENGTH))) return undefined
  const settings = parseBrowserSettings(value.settings)
  const tabs = value.tabs.map(parseTab)
  const lastObservation = value.lastObservation === undefined
    ? undefined
    : parseObservationSummary(value.lastObservation)
  if (settings === undefined || tabs.some(tab => tab === undefined) ||
    (value.lastObservation !== undefined && lastObservation === undefined)) return undefined
  const parsedTabs = tabs as BrowserTabSummary[]
  if (new Set(parsedTabs.map(tab => tab.id)).size !== parsedTabs.length ||
    (value.activeTabId !== undefined && !parsedTabs.some(tab => tab.id === value.activeTabId))) return undefined
  return {
    revision: Number(value.revision),
    settings,
    runtimeStatus: value.runtimeStatus,
    tabs: parsedTabs,
    ...(value.activeTabId === undefined ? {} : { activeTabId: value.activeTabId }),
    canGoBack: value.canGoBack,
    canGoForward: value.canGoForward,
    historyCount: Number(value.historyCount),
    ...(lastObservation === undefined ? {} : { lastObservation }),
    ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage }),
  }
}

export function parseBrowserFrame(value: unknown): BrowserFrame | undefined {
  if (!isRecord(value) || !isString(value.snapshotId, MAX_ID_LENGTH) ||
    !isString(value.tabId, MAX_ID_LENGTH) || !validDate(value.capturedAt) ||
    value.mediaType !== 'image/jpeg' || !Number.isSafeInteger(value.pixelWidth) ||
    Number(value.pixelWidth) <= 0 || Number(value.pixelWidth) > MAX_IMAGE_EDGE ||
    !Number.isSafeInteger(value.pixelHeight) || Number(value.pixelHeight) <= 0 ||
    Number(value.pixelHeight) > MAX_IMAGE_EDGE || !(value.data instanceof Uint8Array) ||
    value.data.byteLength === 0 || value.data.byteLength > MAX_IMAGE_BYTES) return undefined
  return {
    snapshotId: value.snapshotId,
    tabId: value.tabId,
    capturedAt: value.capturedAt,
    mediaType: 'image/jpeg',
    pixelWidth: Number(value.pixelWidth),
    pixelHeight: Number(value.pixelHeight),
    data: value.data.slice(),
  }
}

export function parseBrowserObservation(value: unknown): BrowserObservation | undefined {
  if (!isRecord(value) || value.version !== BROWSER_OBSERVATION_VERSION ||
    !isString(value.ariaSnapshot, MAX_ARIA_LENGTH, true) || typeof value.truncated !== 'boolean' ||
    typeof value.screenshotCaptured !== 'boolean') return undefined
  const summary = parseObservationSummary(value)
  return summary === undefined ? undefined : {
    version: BROWSER_OBSERVATION_VERSION,
    ...summary,
    ariaSnapshot: value.ariaSnapshot,
    truncated: value.truncated,
    screenshotCaptured: value.screenshotCaptured,
  }
}

export function parseBrowserTabsSnapshot(value: unknown): BrowserTabsSnapshot | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'revision', 'activeTabId', 'tabs']) ||
    value.version !== BROWSER_TABS_VERSION || !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 || !isString(value.activeTabId, MAX_ID_LENGTH) ||
    !Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > MAX_TABS) return undefined
  const tabs = value.tabs.map(parseTab)
  if (tabs.some(tab => tab === undefined)) return undefined
  const parsedTabs = tabs as BrowserTabSummary[]
  if (new Set(parsedTabs.map(tab => tab.id)).size !== parsedTabs.length ||
    !parsedTabs.some(tab => tab.id === value.activeTabId)) return undefined
  return {
    version: BROWSER_TABS_VERSION,
    revision: Number(value.revision),
    activeTabId: value.activeTabId,
    tabs: parsedTabs,
  }
}

function sessionActionAndSnapshot(value: Record<string, unknown>): value is Record<string, unknown> & {
  actionId: string
  sessionId: string
  snapshotId: string
} {
  return isString(value.actionId, MAX_ID_LENGTH) && isString(value.sessionId, MAX_ID_LENGTH) &&
    isString(value.snapshotId, MAX_ID_LENGTH)
}

export function parseBrowserNavigateParams(value: unknown): BrowserNavigateParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['actionId', 'sessionId', 'url', 'newTab']) ||
    !isString(value.actionId, MAX_ID_LENGTH) || !isString(value.sessionId, MAX_ID_LENGTH) ||
    (value.newTab !== undefined && typeof value.newTab !== 'boolean')) return undefined
  const url = parseControlledBrowserUrl(value.url)
  return url === undefined ? undefined : {
    actionId: value.actionId,
    sessionId: value.sessionId,
    url,
    ...(value.newTab === undefined ? {} : { newTab: value.newTab }),
  }
}

export function parseBrowserObserveParams(value: unknown): BrowserObserveParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'tabId']) ||
    !isString(value.sessionId, MAX_ID_LENGTH) ||
    (value.tabId !== undefined && !isString(value.tabId, MAX_ID_LENGTH))) return undefined
  return { sessionId: value.sessionId, ...(value.tabId === undefined ? {} : { tabId: value.tabId }) }
}

export function parseBrowserScreenshotParams(value: unknown): BrowserScreenshotParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'snapshotId']) ||
    !isString(value.sessionId, MAX_ID_LENGTH) || !isString(value.snapshotId, MAX_ID_LENGTH)) return undefined
  return { sessionId: value.sessionId, snapshotId: value.snapshotId }
}

export function parseBrowserTabsParams(value: unknown): BrowserTabsParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId']) ||
    !isString(value.sessionId, MAX_ID_LENGTH)) return undefined
  return { sessionId: value.sessionId }
}

export function parseBrowserTabParams(value: unknown): BrowserTabParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'revision', 'action', 'tabId'],
  ) || !isString(value.actionId, MAX_ID_LENGTH) || !isString(value.sessionId, MAX_ID_LENGTH) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    (value.action !== 'new' && value.action !== 'activate' && value.action !== 'close')) {
    return undefined
  }
  if (value.action === 'new') {
    if (value.tabId !== undefined) return undefined
    return {
      actionId: value.actionId,
      sessionId: value.sessionId,
      revision: Number(value.revision),
      action: 'new',
    }
  }
  if (!isString(value.tabId, MAX_ID_LENGTH)) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    revision: Number(value.revision),
    action: value.action,
    tabId: value.tabId,
  }
}

export function parseBrowserClickParams(value: unknown): BrowserClickParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'snapshotId', 'role', 'name', 'exact'],
  ) || !sessionActionAndSnapshot(value) || !isString(value.role, MAX_ROLE_LENGTH) ||
    !isString(value.name, MAX_NAME_LENGTH) ||
    (value.exact !== undefined && typeof value.exact !== 'boolean')) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    snapshotId: value.snapshotId,
    role: value.role,
    name: value.name,
    ...(value.exact === undefined ? {} : { exact: value.exact }),
  }
}

export function parseBrowserTypeParams(value: unknown): BrowserTypeParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'snapshotId', 'role', 'name', 'text', 'submit'],
  ) || !sessionActionAndSnapshot(value) || !isString(value.role, MAX_ROLE_LENGTH) ||
    !isString(value.name, MAX_NAME_LENGTH) || !isString(value.text, MAX_TEXT_LENGTH, true) ||
    (value.submit !== undefined && typeof value.submit !== 'boolean')) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    snapshotId: value.snapshotId,
    role: value.role,
    name: value.name,
    text: value.text,
    ...(value.submit === undefined ? {} : { submit: value.submit }),
  }
}

export function parseBrowserSelectParams(value: unknown): BrowserSelectParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'snapshotId', 'name', 'option', 'exact'],
  ) || !sessionActionAndSnapshot(value) || !isString(value.name, MAX_NAME_LENGTH) ||
    !isString(value.option, MAX_NAME_LENGTH) ||
    (value.exact !== undefined && typeof value.exact !== 'boolean')) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    snapshotId: value.snapshotId,
    name: value.name,
    option: value.option,
    ...(value.exact === undefined ? {} : { exact: value.exact }),
  }
}

export function parseBrowserUploadParams(value: unknown): BrowserUploadParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'workspaceRoot', 'snapshotId', 'name', 'paths', 'exact'],
  ) || !sessionActionAndSnapshot(value) || !isString(value.workspaceRoot, MAX_PATH_LENGTH) ||
    !isString(value.name, MAX_NAME_LENGTH) || !Array.isArray(value.paths) || value.paths.length === 0 ||
    value.paths.length > MAX_UPLOAD_FILES ||
    value.paths.some(path => !isString(path, MAX_PATH_LENGTH)) ||
    new Set(value.paths).size !== value.paths.length ||
    (value.exact !== undefined && typeof value.exact !== 'boolean')) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    workspaceRoot: value.workspaceRoot,
    snapshotId: value.snapshotId,
    name: value.name,
    paths: [...value.paths] as string[],
    ...(value.exact === undefined ? {} : { exact: value.exact }),
  }
}

export function parseBrowserDownloadParams(value: unknown): BrowserDownloadParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'workspaceRoot', 'snapshotId', 'role', 'name', 'path', 'exact'],
  ) || !sessionActionAndSnapshot(value) || !isString(value.workspaceRoot, MAX_PATH_LENGTH) ||
    !isString(value.role, MAX_ROLE_LENGTH) || !isString(value.name, MAX_NAME_LENGTH) ||
    !isString(value.path, MAX_PATH_LENGTH) ||
    (value.exact !== undefined && typeof value.exact !== 'boolean')) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    workspaceRoot: value.workspaceRoot,
    snapshotId: value.snapshotId,
    role: value.role,
    name: value.name,
    path: value.path,
    ...(value.exact === undefined ? {} : { exact: value.exact }),
  }
}

export function parseBrowserDownloadResult(value: unknown): BrowserDownloadResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['version', 'actionId', 'previousSnapshotId', 'path', 'suggestedFilename', 'bytes', 'observation'],
  ) || value.version !== BROWSER_DOWNLOAD_VERSION || !isString(value.actionId, MAX_ID_LENGTH) ||
    !isString(value.previousSnapshotId, MAX_ID_LENGTH) || !isString(value.path, MAX_PATH_LENGTH) ||
    !isString(value.suggestedFilename, MAX_NAME_LENGTH) || !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0 || Number(value.bytes) > MAX_DOWNLOAD_BYTES) return undefined
  const observation = parseBrowserObservation(value.observation)
  if (observation === undefined || observation.snapshotId === value.previousSnapshotId) return undefined
  return {
    version: BROWSER_DOWNLOAD_VERSION,
    actionId: value.actionId,
    previousSnapshotId: value.previousSnapshotId,
    path: value.path,
    suggestedFilename: value.suggestedFilename,
    bytes: Number(value.bytes),
    observation,
  }
}

export function parseBrowserScrollParams(value: unknown): BrowserScrollParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['actionId', 'sessionId', 'snapshotId', 'deltaX', 'deltaY'],
  ) || !sessionActionAndSnapshot(value) || typeof value.deltaX !== 'number' ||
    !Number.isFinite(value.deltaX) ||
    typeof value.deltaY !== 'number' || !Number.isFinite(value.deltaY) ||
    Math.abs(value.deltaX) > MAX_SCROLL_DELTA || Math.abs(value.deltaY) > MAX_SCROLL_DELTA ||
    (value.deltaX === 0 && value.deltaY === 0)) return undefined
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    snapshotId: value.snapshotId,
    deltaX: value.deltaX,
    deltaY: value.deltaY,
  }
}

export function parseBrowserUiNavigateInput(value: unknown): BrowserUiNavigateInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['url', 'newTab']) ||
    (value.newTab !== undefined && typeof value.newTab !== 'boolean')) return undefined
  const url = parseControlledBrowserUrl(value.url)
  return url === undefined ? undefined : {
    url,
    ...(value.newTab === undefined ? {} : { newTab: value.newTab }),
  }
}

export function parseBrowserUiOpenManagementInput(value: unknown): BrowserUiOpenManagementInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['page']) ||
    (value.page !== 'import' && value.page !== 'passwords' && value.page !== 'contacts')) return undefined
  return { page: value.page }
}

export function parseBrowserUiTabInput(value: unknown): BrowserUiTabInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tabId']) || !isString(value.tabId, MAX_ID_LENGTH)) {
    return undefined
  }
  return { tabId: value.tabId }
}

export function parseBrowserUiViewportInput(value: unknown): BrowserUiViewportInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['pixelWidth', 'pixelHeight']) ||
    !Number.isSafeInteger(value.pixelWidth) || !Number.isSafeInteger(value.pixelHeight) ||
    (value.pixelWidth as number) < 240 || (value.pixelWidth as number) > 2_560 ||
    (value.pixelHeight as number) < 240 || (value.pixelHeight as number) > 2_560) return undefined
  return {
    pixelWidth: value.pixelWidth as number,
    pixelHeight: value.pixelHeight as number,
  }
}

function normalizedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function parseBrowserUiPointerInput(value: unknown): BrowserUiPointerInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['snapshotId', 'tabId', 'normalizedX', 'normalizedY', 'button'],
  ) || !isString(value.snapshotId, MAX_ID_LENGTH) || !isString(value.tabId, MAX_ID_LENGTH) ||
    !normalizedCoordinate(value.normalizedX) || !normalizedCoordinate(value.normalizedY) ||
    (value.button !== undefined && value.button !== 'left' && value.button !== 'right')) return undefined
  return {
    snapshotId: value.snapshotId,
    tabId: value.tabId,
    normalizedX: value.normalizedX,
    normalizedY: value.normalizedY,
    ...(value.button === undefined ? {} : { button: value.button }),
  }
}

export function parseBrowserUiScrollInput(value: unknown): BrowserUiScrollInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['snapshotId', 'tabId', 'normalizedX', 'normalizedY', 'deltaX', 'deltaY'],
  ) || !isString(value.snapshotId, MAX_ID_LENGTH) || !isString(value.tabId, MAX_ID_LENGTH) ||
    !normalizedCoordinate(value.normalizedX) || !normalizedCoordinate(value.normalizedY) ||
    typeof value.deltaX !== 'number' || !Number.isFinite(value.deltaX) ||
    typeof value.deltaY !== 'number' || !Number.isFinite(value.deltaY) ||
    Math.abs(value.deltaX) > MAX_SCROLL_DELTA || Math.abs(value.deltaY) > MAX_SCROLL_DELTA ||
    (value.deltaX === 0 && value.deltaY === 0)) return undefined
  return {
    snapshotId: value.snapshotId,
    tabId: value.tabId,
    normalizedX: value.normalizedX,
    normalizedY: value.normalizedY,
    deltaX: value.deltaX,
    deltaY: value.deltaY,
  }
}

function parseBrowserUiKeyboardAction(value: unknown): BrowserUiKeyboardAction | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (value.kind === 'text') {
    if (!hasOnlyKeys(value, ['kind', 'text']) || !isString(value.text, MAX_TEXT_LENGTH)) return undefined
    return { kind: 'text', text: value.text }
  }
  if (value.kind !== 'press' || !hasOnlyKeys(value, ['kind', 'key', 'modifiers']) ||
    !isString(value.key, 32) ||
    (!BROWSER_PRESS_KEYS.has(value.key) && !/^[\x20-\x7e]$/.test(value.key))) return undefined
  if (value.modifiers === undefined) return { kind: 'press', key: value.key }
  if (!Array.isArray(value.modifiers) || value.modifiers.length > 4 ||
    !value.modifiers.every(modifier => BROWSER_KEY_MODIFIERS.has(modifier as BrowserUiKeyModifier)) ||
    new Set(value.modifiers).size !== value.modifiers.length) return undefined
  return {
    kind: 'press',
    key: value.key,
    modifiers: value.modifiers as BrowserUiKeyModifier[],
  }
}

export function parseBrowserUiKeyboardInput(value: unknown): BrowserUiKeyboardInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['snapshotId', 'tabId', 'actions']) ||
    !isString(value.snapshotId, MAX_ID_LENGTH) || !isString(value.tabId, MAX_ID_LENGTH) ||
    !Array.isArray(value.actions) || value.actions.length === 0 ||
    value.actions.length > MAX_UI_KEYBOARD_ACTIONS) return undefined
  const actions = value.actions.map(parseBrowserUiKeyboardAction)
  if (actions.some(action => action === undefined)) return undefined
  const typedCharacters = actions.reduce(
    (total, action) => total + (action?.kind === 'text' ? action.text.length : 0),
    0,
  )
  if (typedCharacters > MAX_TEXT_LENGTH) return undefined
  return {
    snapshotId: value.snapshotId,
    tabId: value.tabId,
    actions: actions as BrowserUiKeyboardAction[],
  }
}

export function parseBrowserHistory(value: unknown): BrowserHistoryEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined
  const entries = value.map(item => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'url', 'title', 'visitedAt']) ||
      !isString(item.id, MAX_ID_LENGTH) || !isString(item.url, MAX_URL_LENGTH) ||
      !isString(item.title, MAX_TITLE_LENGTH, true) || !validDate(item.visitedAt)) return undefined
    return { id: item.id, url: item.url, title: item.title, visitedAt: item.visitedAt }
  })
  if (entries.some(entry => entry === undefined)) return undefined
  const parsed = entries as BrowserHistoryEntry[]
  return new Set(parsed.map(entry => entry.id)).size === parsed.length ? parsed : undefined
}
