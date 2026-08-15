export const COMPUTER_OBSERVATION_VERSION = 1 as const

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

export interface ComputerObservation {
  version: typeof COMPUTER_OBSERVATION_VERSION
  snapshotId: string
  observedAt: string
  target: ComputerTarget
  foregroundApplication?: ComputerApplication
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

const MAX_ID_LENGTH = 256
const MAX_NAME_LENGTH = 512
const MAX_TEXT_LENGTH = 32_768
const MAX_ITEMS = 1_000
const MAX_ACTIONS = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseBounds(value: unknown): ComputerBounds | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) || !isFiniteNumber(value.height) ||
    value.width < 0 || value.height < 0) return undefined
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function isPermissionStatus(value: unknown): value is ComputerPermissionStatus {
  return value === 'granted' || value === 'denied' || value === 'not-determined' ||
    value === 'unavailable'
}

export function parseComputerPermissions(value: unknown): ComputerPermissions | undefined {
  if (!isRecord(value) || typeof value.supported !== 'boolean' ||
    !isPermissionStatus(value.screenRecording) || !isPermissionStatus(value.accessibility) ||
    typeof value.canObserve !== 'boolean') return undefined
  if (value.canObserve && (!value.supported || value.screenRecording !== 'granted')) return undefined
  return {
    supported: value.supported,
    screenRecording: value.screenRecording,
    accessibility: value.accessibility,
    canObserve: value.canObserve,
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
  const elements = value.elements.map(parseElement)
  if (target === undefined || bounds === undefined || elements.some(element => element === undefined) ||
    (value.foregroundApplication !== undefined && foregroundApplication === undefined) ||
    (value.capture.ocrText !== undefined && !isString(value.capture.ocrText, MAX_TEXT_LENGTH, true))) {
    return undefined
  }
  return {
    version: COMPUTER_OBSERVATION_VERSION,
    snapshotId: value.snapshotId,
    observedAt: value.observedAt,
    target,
    ...(foregroundApplication === undefined ? {} : { foregroundApplication }),
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
