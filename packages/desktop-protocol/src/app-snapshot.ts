import { ComputerPermissions, parseComputerPermissions } from './computer.js'

export const APP_SNAPSHOT_SHORTCUTS = [
  'CommandOrControl+Shift+2',
  'CommandOrControl+Shift+A',
  'CommandOrControl+Option+2',
] as const

export type AppSnapshotShortcut = typeof APP_SNAPSHOT_SHORTCUTS[number]

export type AppSnapshotDestination =
  | { kind: 'automatic' }
  | { kind: 'session'; sessionId: string }

export interface AppSnapshotSettings {
  shortcut: AppSnapshotShortcut
  destination: AppSnapshotDestination
  captureSound: boolean
}

export interface UpdateAppSnapshotSettingsInput {
  shortcut?: AppSnapshotShortcut
  destination?: AppSnapshotDestination
  captureSound?: boolean
}

export interface AppSnapshotCaptureSummary {
  id: string
  capturedAt: string
  sourceName: string
  bundleId?: string
  pixelWidth: number
  pixelHeight: number
}

export interface AppSnapshotState {
  revision: number
  settings: AppSnapshotSettings
  shortcutRegistered: boolean
  capturing: boolean
  permissions: ComputerPermissions
  lastCapture?: AppSnapshotCaptureSummary
  statusMessage?: string
}

export interface AppSnapshotCapture extends AppSnapshotCaptureSummary {
  destination: AppSnapshotDestination
  mediaType: 'image/jpeg' | 'image/png'
  fileName: string
  data: Uint8Array
  ocrText?: string
}

export interface AppSnapshotErrorNotice {
  message: string
}

const MAX_ID_LENGTH = 256
const MAX_NAME_LENGTH = 512
const MAX_FILE_NAME_LENGTH = 256
const MAX_SESSION_ID_LENGTH = 256
const MAX_STATUS_LENGTH = 1_000
const MAX_OCR_LENGTH = 12_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_EDGE = 8_192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isShortcut(value: unknown): value is AppSnapshotShortcut {
  return typeof value === 'string' && APP_SNAPSHOT_SHORTCUTS.includes(value as AppSnapshotShortcut)
}

export function parseAppSnapshotDestination(value: unknown): AppSnapshotDestination | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (value.kind === 'automatic' && hasOnlyKeys(value, ['kind'])) return { kind: 'automatic' }
  if (value.kind !== 'session' || !hasOnlyKeys(value, ['kind', 'sessionId']) ||
    !isString(value.sessionId, MAX_SESSION_ID_LENGTH)) return undefined
  return { kind: 'session', sessionId: value.sessionId }
}

export function parseAppSnapshotSettings(value: unknown): AppSnapshotSettings | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['shortcut', 'destination', 'captureSound']) ||
    !isShortcut(value.shortcut) || typeof value.captureSound !== 'boolean') return undefined
  const destination = parseAppSnapshotDestination(value.destination)
  if (destination === undefined) return undefined
  return { shortcut: value.shortcut, destination, captureSound: value.captureSound }
}

export function parseUpdateAppSnapshotSettingsInput(
  value: unknown,
): UpdateAppSnapshotSettingsInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['shortcut', 'destination', 'captureSound'])) return undefined
  if (value.shortcut !== undefined && !isShortcut(value.shortcut)) return undefined
  if (value.captureSound !== undefined && typeof value.captureSound !== 'boolean') return undefined
  const destination = value.destination === undefined
    ? undefined
    : parseAppSnapshotDestination(value.destination)
  if (value.destination !== undefined && destination === undefined) return undefined
  return {
    ...(value.shortcut === undefined ? {} : { shortcut: value.shortcut }),
    ...(destination === undefined ? {} : { destination }),
    ...(value.captureSound === undefined ? {} : { captureSound: value.captureSound }),
  }
}

function parseCaptureSummary(value: unknown): AppSnapshotCaptureSummary | undefined {
  if (!isRecord(value) || !isString(value.id, MAX_ID_LENGTH) ||
    !isString(value.capturedAt, MAX_NAME_LENGTH) || Number.isNaN(Date.parse(value.capturedAt)) ||
    !isString(value.sourceName, MAX_NAME_LENGTH) ||
    !Number.isSafeInteger(value.pixelWidth) || Number(value.pixelWidth) <= 0 ||
    Number(value.pixelWidth) > MAX_IMAGE_EDGE ||
    !Number.isSafeInteger(value.pixelHeight) || Number(value.pixelHeight) <= 0 ||
    Number(value.pixelHeight) > MAX_IMAGE_EDGE) return undefined
  if (value.bundleId !== undefined && !isString(value.bundleId, MAX_NAME_LENGTH)) return undefined
  return {
    id: value.id,
    capturedAt: value.capturedAt,
    sourceName: value.sourceName,
    ...(value.bundleId === undefined ? {} : { bundleId: value.bundleId }),
    pixelWidth: Number(value.pixelWidth),
    pixelHeight: Number(value.pixelHeight),
  }
}

export function parseAppSnapshotState(value: unknown): AppSnapshotState | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    typeof value.shortcutRegistered !== 'boolean' || typeof value.capturing !== 'boolean') return undefined
  const settings = parseAppSnapshotSettings(value.settings)
  const permissions = parseComputerPermissions(value.permissions)
  const lastCapture = value.lastCapture === undefined ? undefined : parseCaptureSummary(value.lastCapture)
  if (settings === undefined || permissions === undefined ||
    (value.lastCapture !== undefined && lastCapture === undefined) ||
    (value.statusMessage !== undefined && !isString(value.statusMessage, MAX_STATUS_LENGTH))) return undefined
  return {
    revision: Number(value.revision),
    settings,
    shortcutRegistered: value.shortcutRegistered,
    capturing: value.capturing,
    permissions,
    ...(lastCapture === undefined ? {} : { lastCapture }),
    ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage }),
  }
}

export function parseAppSnapshotCapture(value: unknown): AppSnapshotCapture | undefined {
  if (!isRecord(value)) return undefined
  const summary = parseCaptureSummary(value)
  const destination = parseAppSnapshotDestination(value.destination)
  if (summary === undefined || destination === undefined ||
    (value.mediaType !== 'image/jpeg' && value.mediaType !== 'image/png') ||
    !isString(value.fileName, MAX_FILE_NAME_LENGTH) || !(value.data instanceof Uint8Array) ||
    value.data.byteLength === 0 || value.data.byteLength > MAX_IMAGE_BYTES ||
    (value.ocrText !== undefined && (typeof value.ocrText !== 'string' || value.ocrText.length > MAX_OCR_LENGTH))) {
    return undefined
  }
  return {
    ...summary,
    destination,
    mediaType: value.mediaType,
    fileName: value.fileName,
    data: value.data.slice(),
    ...(value.ocrText === undefined ? {} : { ocrText: value.ocrText }),
  }
}
