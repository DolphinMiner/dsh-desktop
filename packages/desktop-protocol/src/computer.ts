export const COMPUTER_OBSERVATION_VERSION = 2 as const
export const COMPUTER_ACTION_VERSION = 1 as const

export type ComputerPermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'unavailable'

export interface ComputerPermissions {
  supported: boolean
  screenRecording: ComputerPermissionStatus
  accessibility: ComputerPermissionStatus
  canObserve: boolean
  canAct: boolean
}

export interface ComputerBounds {
  x: number
  y: number
  width: number
  height: number
}

export type ComputerTargetKind = 'application' | 'window' | 'display'

export interface ComputerTarget {
  id: string
  kind: ComputerTargetKind
  name: string
  applicationName?: string
  bundleId?: string
  pid?: number
  frontmost?: boolean
  bounds?: ComputerBounds
  displayScale?: number
}

export interface ComputerApplication {
  id: string
  name: string
  bundleId?: string
  pid: number
  frontmost: boolean
}

export interface ComputerElement {
  id: string
  role: string
  label?: string
  value?: string
  actions: string[]
  bounds?: ComputerBounds
  secure: boolean
}

export interface ComputerDisplayState {
  id: string
  bounds: ComputerBounds
  displayScale: number
}

export interface ComputerSnapshotCompatibility {
  surfaceId: string
  surfaceBounds: ComputerBounds
  displayTopology: ComputerDisplayState[]
  foregroundApplicationId?: string
}

export interface ComputerObservation {
  version: typeof COMPUTER_OBSERVATION_VERSION
  snapshotId: string
  observedAt: string
  target: ComputerTarget
  foregroundApplication?: ComputerApplication
  compatibility: ComputerSnapshotCompatibility
  capture: {
    bounds: ComputerBounds
    displayScale: number
    pixelWidth: number
    pixelHeight: number
    screenshotCaptured: boolean
    ocrText?: string
  }
  elements: ComputerElement[]
  truncated: boolean
  warnings: string[]
}

export interface ComputerTargetList {
  permissions: ComputerPermissions
  targets: ComputerTarget[]
}

export interface ComputerApplicationList {
  permissions: ComputerPermissions
  applications: ComputerApplication[]
  selectedTarget?: ComputerTarget
}

export interface ComputerObservationSummary {
  snapshotId: string
  observedAt: string
  target: ComputerTarget
  elementCount: number
  screenshotCaptured: boolean
}

export interface ComputerControlSnapshot {
  revision: number
  enabled: boolean
  observing: boolean
  permissions: ComputerPermissions
  targets: ComputerTarget[]
  selectedTarget?: ComputerTarget
  lastObservation?: ComputerObservationSummary
  statusMessage?: string
}

export interface SelectComputerTargetInput {
  targetId: string
}

export interface ComputerObserveParams {
  sessionId: string
}

export interface ComputerPoint {
  x: number
  y: number
}

export type ComputerActionTarget = {
  mode: 'element'
  elementId: string
} | {
  mode: 'point'
  coordinateSpace: 'capture'
  point: ComputerPoint
}

export type ComputerMouseButton = 'left' | 'right'
export type ComputerKeyModifier = 'command' | 'control' | 'option' | 'shift'

export type ComputerAction = {
  kind: 'click'
  target: ComputerActionTarget
  button: ComputerMouseButton
  clickCount: 1 | 2
} | {
  kind: 'type'
  elementId: string
  text: string
  replace: boolean
} | {
  kind: 'key'
  key: string
  modifiers: ComputerKeyModifier[]
} | {
  kind: 'scroll'
  target?: ComputerActionTarget
  deltaX: number
  deltaY: number
}

export interface ComputerActParams {
  actionId: string
  sessionId: string
  snapshotId: string
  action: ComputerAction
}

export type ComputerActionSummary = {
  kind: 'click'
  target: ComputerActionTarget
  button: ComputerMouseButton
  clickCount: 1 | 2
} | {
  kind: 'type'
  elementId: string
  textLength: number
  replace: boolean
} | {
  kind: 'key'
  key: string
  modifiers: ComputerKeyModifier[]
} | {
  kind: 'scroll'
  target?: ComputerActionTarget
  deltaX: number
  deltaY: number
}

export interface ComputerActionResult {
  version: typeof COMPUTER_ACTION_VERSION
  actionId: string
  previousSnapshotId: string
  completedAt: string
  action: ComputerActionSummary
  observation: ComputerObservation
}

const MAX_ID_LENGTH = 256
const MAX_NAME_LENGTH = 512
const MAX_TEXT_LENGTH = 32_768
const MAX_ITEMS = 1_000
const MAX_ACTIONS = 64
const MAX_DISPLAYS = 32
const MAX_TYPED_TEXT_LENGTH = 8_192
const MAX_SCROLL_DELTA = 10_000
const MAX_COORDINATE = 1_000_000

const NAMED_KEYS = new Set([
  'backspace', 'delete', 'down', 'end', 'enter', 'escape', 'home', 'left',
  'page-down', 'page-up', 'right', 'space', 'tab', 'up',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function parseBounds(value: unknown): ComputerBounds | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) || !isFiniteNumber(value.height) ||
    value.width < 0 || value.height < 0) return undefined
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function boundsEqual(left: ComputerBounds, right: ComputerBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width &&
    left.height === right.height
}

function isPermissionStatus(value: unknown): value is ComputerPermissionStatus {
  return value === 'granted' || value === 'denied' || value === 'not-determined' ||
    value === 'unavailable'
}

export function parseComputerPermissions(value: unknown): ComputerPermissions | undefined {
  if (!isRecord(value) || typeof value.supported !== 'boolean' ||
    !isPermissionStatus(value.screenRecording) || !isPermissionStatus(value.accessibility) ||
    typeof value.canObserve !== 'boolean' || typeof value.canAct !== 'boolean') return undefined
  if (value.canObserve && (!value.supported || value.screenRecording !== 'granted')) return undefined
  if (value.canAct && (!value.canObserve || value.accessibility !== 'granted')) return undefined
  return {
    supported: value.supported,
    screenRecording: value.screenRecording,
    accessibility: value.accessibility,
    canObserve: value.canObserve,
    canAct: value.canAct,
  }
}

export function parseComputerTarget(value: unknown): ComputerTarget | undefined {
  if (!isRecord(value) || !isString(value.id, MAX_ID_LENGTH) ||
    (value.kind !== 'application' && value.kind !== 'window' && value.kind !== 'display') ||
    !isString(value.name, MAX_NAME_LENGTH)) return undefined
  if (value.applicationName !== undefined && !isString(value.applicationName, MAX_NAME_LENGTH)) return undefined
  if (value.bundleId !== undefined && !isString(value.bundleId, MAX_NAME_LENGTH)) return undefined
  if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0)) return undefined
  if (value.frontmost !== undefined && typeof value.frontmost !== 'boolean') return undefined
  const bounds = value.bounds === undefined ? undefined : parseBounds(value.bounds)
  if (value.bounds !== undefined && bounds === undefined) return undefined
  if (value.displayScale !== undefined &&
    (!isFiniteNumber(value.displayScale) || value.displayScale <= 0 || value.displayScale > 8)) return undefined
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    ...(value.applicationName === undefined ? {} : { applicationName: value.applicationName }),
    ...(value.bundleId === undefined ? {} : { bundleId: value.bundleId }),
    ...(value.pid === undefined ? {} : { pid: Number(value.pid) }),
    ...(value.frontmost === undefined ? {} : { frontmost: value.frontmost }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(value.displayScale === undefined ? {} : { displayScale: value.displayScale }),
  }
}

function parseApplication(value: unknown): ComputerApplication | undefined {
  if (!isRecord(value) || !isString(value.id, MAX_ID_LENGTH) || !isString(value.name, MAX_NAME_LENGTH) ||
    !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.frontmost !== 'boolean') {
    return undefined
  }
  if (value.bundleId !== undefined && !isString(value.bundleId, MAX_NAME_LENGTH)) return undefined
  return {
    id: value.id,
    name: value.name,
    ...(value.bundleId === undefined ? {} : { bundleId: value.bundleId }),
    pid: Number(value.pid),
    frontmost: value.frontmost,
  }
}

function parseElement(value: unknown): ComputerElement | undefined {
  if (!isRecord(value) || !isString(value.id, MAX_ID_LENGTH) || !isString(value.role, MAX_NAME_LENGTH) ||
    !Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS ||
    !value.actions.every(action => isString(action, MAX_NAME_LENGTH)) || typeof value.secure !== 'boolean') {
    return undefined
  }
  if (value.label !== undefined && !isString(value.label, MAX_TEXT_LENGTH, true)) return undefined
  if (value.value !== undefined && !isString(value.value, MAX_TEXT_LENGTH, true)) return undefined
  if (value.secure && value.value !== undefined) return undefined
  const bounds = value.bounds === undefined ? undefined : parseBounds(value.bounds)
  if (value.bounds !== undefined && bounds === undefined) return undefined
  return {
    id: value.id,
    role: value.role,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.value === undefined ? {} : { value: value.value }),
    actions: [...value.actions],
    ...(bounds === undefined ? {} : { bounds }),
    secure: value.secure,
  }
}

function parseDisplayState(value: unknown): ComputerDisplayState | undefined {
  if (!isRecord(value) || !isString(value.id, MAX_ID_LENGTH)) return undefined
  const bounds = parseBounds(value.bounds)
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0 ||
    !isFiniteNumber(value.displayScale) ||
    value.displayScale <= 0 || value.displayScale > 8) return undefined
  return { id: value.id, bounds, displayScale: value.displayScale }
}

function parseCompatibility(value: unknown): ComputerSnapshotCompatibility | undefined {
  if (!isRecord(value) || !isString(value.surfaceId, MAX_ID_LENGTH) ||
    !Array.isArray(value.displayTopology) || value.displayTopology.length === 0 ||
    value.displayTopology.length > MAX_DISPLAYS ||
    (value.foregroundApplicationId !== undefined &&
      !isString(value.foregroundApplicationId, MAX_ID_LENGTH))) return undefined
  const surfaceBounds = parseBounds(value.surfaceBounds)
  const displayTopology = value.displayTopology.map(parseDisplayState)
  if (surfaceBounds === undefined || surfaceBounds.width <= 0 || surfaceBounds.height <= 0 ||
    displayTopology.some(display => display === undefined)) return undefined
  const displayIds = (displayTopology as ComputerDisplayState[]).map(display => display.id)
  if (new Set(displayIds).size !== displayIds.length) return undefined
  return {
    surfaceId: value.surfaceId,
    surfaceBounds,
    displayTopology: displayTopology as ComputerDisplayState[],
    ...(value.foregroundApplicationId === undefined
      ? {}
      : { foregroundApplicationId: value.foregroundApplicationId }),
  }
}

export function parseComputerTargetList(value: unknown): ComputerTargetList | undefined {
  if (!isRecord(value) || !Array.isArray(value.targets) || value.targets.length > MAX_ITEMS) return undefined
  const permissions = parseComputerPermissions(value.permissions)
  const targets = value.targets.map(parseComputerTarget)
  if (permissions === undefined || targets.some(target => target === undefined)) return undefined
  return { permissions, targets: targets as ComputerTarget[] }
}

export function parseComputerApplicationList(value: unknown): ComputerApplicationList | undefined {
  if (!isRecord(value) || !Array.isArray(value.applications) || value.applications.length > MAX_ITEMS) {
    return undefined
  }
  const permissions = parseComputerPermissions(value.permissions)
  const applications = value.applications.map(parseApplication)
  const selectedTarget = value.selectedTarget === undefined
    ? undefined
    : parseComputerTarget(value.selectedTarget)
  if (permissions === undefined || applications.some(application => application === undefined) ||
    (value.selectedTarget !== undefined && selectedTarget === undefined)) return undefined
  return {
    permissions,
    applications: applications as ComputerApplication[],
    ...(selectedTarget === undefined ? {} : { selectedTarget }),
  }
}

export function parseComputerObservation(value: unknown): ComputerObservation | undefined {
  if (!isRecord(value) || value.version !== COMPUTER_OBSERVATION_VERSION ||
    !isString(value.snapshotId, MAX_ID_LENGTH) || !isString(value.observedAt, 64) ||
    Number.isNaN(Date.parse(value.observedAt)) || !isRecord(value.capture) ||
    !isFiniteNumber(value.capture.displayScale) || value.capture.displayScale <= 0 ||
    value.capture.displayScale > 8 || !Number.isSafeInteger(value.capture.pixelWidth) ||
    Number(value.capture.pixelWidth) < 0 || !Number.isSafeInteger(value.capture.pixelHeight) ||
    Number(value.capture.pixelHeight) < 0 || typeof value.capture.screenshotCaptured !== 'boolean' ||
    !Array.isArray(value.elements) || value.elements.length > MAX_ITEMS ||
    typeof value.truncated !== 'boolean' || !Array.isArray(value.warnings) ||
    value.warnings.length > MAX_ITEMS || !value.warnings.every(item => isString(item, MAX_TEXT_LENGTH, true))) {
    return undefined
  }
  const target = parseComputerTarget(value.target)
  const foregroundApplication = value.foregroundApplication === undefined
    ? undefined
    : parseApplication(value.foregroundApplication)
  const bounds = parseBounds(value.capture.bounds)
  const compatibility = parseCompatibility(value.compatibility)
  const elements = value.elements.map(parseElement)
  if (target === undefined || bounds === undefined || compatibility === undefined ||
    elements.some(element => element === undefined) ||
    (value.foregroundApplication !== undefined && foregroundApplication === undefined) ||
    !boundsEqual(bounds, compatibility.surfaceBounds) ||
    (compatibility.foregroundApplicationId !== foregroundApplication?.id) ||
    (value.capture.ocrText !== undefined && !isString(value.capture.ocrText, MAX_TEXT_LENGTH, true))) {
    return undefined
  }
  return {
    version: COMPUTER_OBSERVATION_VERSION,
    snapshotId: value.snapshotId,
    observedAt: value.observedAt,
    target,
    ...(foregroundApplication === undefined ? {} : { foregroundApplication }),
    compatibility,
    capture: {
      bounds,
      displayScale: value.capture.displayScale,
      pixelWidth: Number(value.capture.pixelWidth),
      pixelHeight: Number(value.capture.pixelHeight),
      screenshotCaptured: value.capture.screenshotCaptured,
      ...(value.capture.ocrText === undefined ? {} : { ocrText: value.capture.ocrText }),
    },
    elements: elements as ComputerElement[],
    truncated: value.truncated,
    warnings: [...value.warnings],
  }
}

export function parseSelectComputerTargetInput(value: unknown): SelectComputerTargetInput | undefined {
  if (!isRecord(value) || !isString(value.targetId, MAX_ID_LENGTH) || Object.keys(value).length !== 1) {
    return undefined
  }
  return { targetId: value.targetId }
}

function parseActionTarget(value: unknown): ComputerActionTarget | undefined {
  if (!isRecord(value)) return undefined
  if (value.mode === 'element') {
    if (!hasOnlyKeys(value, ['mode', 'elementId']) || !isString(value.elementId, MAX_ID_LENGTH)) {
      return undefined
    }
    return { mode: 'element', elementId: value.elementId }
  }
  if (value.mode !== 'point' || value.coordinateSpace !== 'capture' ||
    !hasOnlyKeys(value, ['mode', 'coordinateSpace', 'point']) || !isRecord(value.point) ||
    !hasOnlyKeys(value.point, ['x', 'y']) || !isFiniteNumber(value.point.x) ||
    !isFiniteNumber(value.point.y) || value.point.x < 0 || value.point.y < 0 ||
    value.point.x > MAX_COORDINATE || value.point.y > MAX_COORDINATE) return undefined
  return {
    mode: 'point',
    coordinateSpace: 'capture',
    point: { x: value.point.x, y: value.point.y },
  }
}

function parseModifiers(value: unknown): ComputerKeyModifier[] | undefined {
  if (!Array.isArray(value) || value.length > 4 ||
    !value.every(item => item === 'command' || item === 'control' || item === 'option' || item === 'shift') ||
    new Set(value).size !== value.length) return undefined
  return [...value] as ComputerKeyModifier[]
}

function isComputerKey(value: unknown): value is string {
  return isString(value, 32) && (NAMED_KEYS.has(value) || /^[A-Za-z0-9]$/.test(value))
}

export function parseComputerAction(value: unknown): ComputerAction | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'click') {
    const target = parseActionTarget(value.target)
    if (!hasOnlyKeys(value, ['kind', 'target', 'button', 'clickCount']) || target === undefined ||
      (value.button !== 'left' && value.button !== 'right') ||
      (value.clickCount !== 1 && value.clickCount !== 2)) return undefined
    return { kind: 'click', target, button: value.button, clickCount: value.clickCount }
  }
  if (value.kind === 'type') {
    if (!hasOnlyKeys(value, ['kind', 'elementId', 'text', 'replace']) ||
      !isString(value.elementId, MAX_ID_LENGTH) ||
      !isString(value.text, MAX_TYPED_TEXT_LENGTH) || value.text.includes('\0') ||
      typeof value.replace !== 'boolean') return undefined
    return { kind: 'type', elementId: value.elementId, text: value.text, replace: value.replace }
  }
  if (value.kind === 'key') {
    const modifiers = parseModifiers(value.modifiers)
    if (!hasOnlyKeys(value, ['kind', 'key', 'modifiers']) || !isComputerKey(value.key) ||
      modifiers === undefined) return undefined
    return { kind: 'key', key: value.key, modifiers }
  }
  if (value.kind === 'scroll') {
    const target = value.target === undefined ? undefined : parseActionTarget(value.target)
    if (!hasOnlyKeys(value, ['kind', 'target', 'deltaX', 'deltaY']) ||
      (value.target !== undefined && target === undefined) || !isFiniteNumber(value.deltaX) ||
      !isFiniteNumber(value.deltaY) || Math.abs(value.deltaX) > MAX_SCROLL_DELTA ||
      Math.abs(value.deltaY) > MAX_SCROLL_DELTA || (value.deltaX === 0 && value.deltaY === 0)) {
      return undefined
    }
    return {
      kind: 'scroll',
      ...(target === undefined ? {} : { target }),
      deltaX: value.deltaX,
      deltaY: value.deltaY,
    }
  }
  return undefined
}

export function parseComputerActParams(value: unknown): ComputerActParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['actionId', 'sessionId', 'snapshotId', 'action']) ||
    !isString(value.actionId, 128) || !isString(value.sessionId, 256) ||
    !isString(value.snapshotId, MAX_ID_LENGTH)) return undefined
  const action = parseComputerAction(value.action)
  return action === undefined ? undefined : {
    actionId: value.actionId,
    sessionId: value.sessionId,
    snapshotId: value.snapshotId,
    action,
  }
}

export function summarizeComputerAction(action: ComputerAction): ComputerActionSummary {
  if (action.kind === 'type') {
    return {
      kind: 'type',
      elementId: action.elementId,
      textLength: action.text.length,
      replace: action.replace,
    }
  }
  if (action.kind === 'click') {
    return { ...action, target: structuredClone(action.target) }
  }
  if (action.kind === 'key') return { ...action, modifiers: [...action.modifiers] }
  return {
    ...action,
    ...(action.target === undefined ? {} : { target: structuredClone(action.target) }),
  }
}

function parseActionSummary(value: unknown): ComputerActionSummary | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'type') {
    if (!hasOnlyKeys(value, ['kind', 'elementId', 'textLength', 'replace']) ||
      !isString(value.elementId, MAX_ID_LENGTH) || !Number.isSafeInteger(value.textLength) ||
      Number(value.textLength) < 1 || Number(value.textLength) > MAX_TYPED_TEXT_LENGTH ||
      typeof value.replace !== 'boolean') return undefined
    return {
      kind: 'type',
      elementId: value.elementId,
      textLength: Number(value.textLength),
      replace: value.replace,
    }
  }
  const action = parseComputerAction(value)
  return action === undefined || action.kind === 'type' ? undefined : summarizeComputerAction(action)
}

export function parseComputerActionResult(value: unknown): ComputerActionResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['version', 'actionId', 'previousSnapshotId', 'completedAt', 'action', 'observation'],
  ) || value.version !== COMPUTER_ACTION_VERSION ||
    !isString(value.actionId, 128) || !isString(value.previousSnapshotId, MAX_ID_LENGTH) ||
    !isString(value.completedAt, 64) || Number.isNaN(Date.parse(value.completedAt))) return undefined
  const action = parseActionSummary(value.action)
  const observation = parseComputerObservation(value.observation)
  if (action === undefined || observation === undefined ||
    observation.snapshotId === value.previousSnapshotId) return undefined
  return {
    version: COMPUTER_ACTION_VERSION,
    actionId: value.actionId,
    previousSnapshotId: value.previousSnapshotId,
    completedAt: value.completedAt,
    action,
    observation,
  }
}
