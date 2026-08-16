export interface DesktopFilesListInput {
  workspaceRoot: string
  path?: string
}

export interface DesktopFileOpenInput {
  workspaceRoot: string
  path: string
}

export interface DesktopFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
}

export interface DesktopFileListing {
  workspaceRoot: string
  path: string
  parent?: string
  entries: DesktopFileEntry[]
  truncated: boolean
}

export interface DesktopTerminalStartInput {
  workspaceRoot: string
}

export interface DesktopTerminalWriteInput {
  data: string
}

export interface DesktopTerminalState {
  running: boolean
  cwd?: string
  exitCode?: number
}

const MAX_PATH_LENGTH = 4_096
const MAX_TERMINAL_INPUT = 8_192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && value.includes('\0') === false
}

export function parseDesktopFilesListInput(value: unknown): DesktopFilesListInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['workspaceRoot', 'path']) || !path(value.workspaceRoot) ||
    (value.path !== undefined && !path(value.path))) return undefined
  return {
    workspaceRoot: value.workspaceRoot,
    ...(value.path === undefined ? {} : { path: value.path }),
  }
}

export function parseDesktopFileOpenInput(value: unknown): DesktopFileOpenInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['workspaceRoot', 'path']) ||
    !path(value.workspaceRoot) || !path(value.path)) return undefined
  return { workspaceRoot: value.workspaceRoot, path: value.path }
}

export function parseDesktopTerminalStartInput(value: unknown): DesktopTerminalStartInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['workspaceRoot']) || !path(value.workspaceRoot)) return undefined
  return { workspaceRoot: value.workspaceRoot }
}

export function parseDesktopTerminalWriteInput(value: unknown): DesktopTerminalWriteInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['data']) || typeof value.data !== 'string' ||
    value.data.length === 0 || value.data.length > MAX_TERMINAL_INPUT || value.data.includes('\0')) return undefined
  return { data: value.data }
}
