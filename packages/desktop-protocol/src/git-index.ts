import type { GitDiscoverParams, GitStatusParams, GitStatusSnapshot } from './git.js'
import { parseGitDiscoverParams, parseGitStatusParams, parseGitStatusSnapshot } from './git.js'

const MAX_PATH_LENGTH = 4_096
const MAX_PATHS = 256
const MAX_TOTAL_PATH_LENGTH = 65_536

export type GitIndexMutationKind = 'stage' | 'unstage'

export interface DesktopGitIndexMutationInput extends GitDiscoverParams {
  requestId: string
  kind: GitIndexMutationKind
  paths: string[]
}

export interface GitIndexMutationParams extends GitStatusParams {
  requestId: string
  kind: GitIndexMutationKind
  paths: string[]
}

export interface GitIndexMutationResult {
  operationId: string
  kind: GitIndexMutationKind
  status: GitStatusSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function parseKind(value: unknown): GitIndexMutationKind | undefined {
  return value === 'stage' || value === 'unstage' ? value : undefined
}

function parsePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATHS) return undefined
  if (value.some(path => typeof path !== 'string' || path.length < 1 || path.length > MAX_PATH_LENGTH ||
    path.includes('\0')) || new Set(value).size !== value.length ||
    value.reduce((total, path) => total + (path as string).length, 0) > MAX_TOTAL_PATH_LENGTH) return undefined
  return [...value] as string[]
}

export function parseDesktopGitIndexMutationInput(value: unknown): DesktopGitIndexMutationInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'requestId', 'kind', 'paths']) ||
    !isUuid(value.requestId)) return undefined
  const base = parseGitDiscoverParams(value)
  const kind = parseKind(value.kind)
  const paths = parsePaths(value.paths)
  return base === undefined || kind === undefined || paths === undefined
    ? undefined
    : { ...base, requestId: value.requestId, kind, paths }
}

export function parseGitIndexMutationParams(value: unknown): GitIndexMutationParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'repositoryRoot', 'requestId', 'kind', 'paths',
  ]) || !isUuid(value.requestId)) return undefined
  const base = parseGitStatusParams(value)
  const kind = parseKind(value.kind)
  const paths = parsePaths(value.paths)
  return base === undefined || kind === undefined || paths === undefined
    ? undefined
    : { ...base, requestId: value.requestId, kind, paths }
}

export function parseGitIndexMutationResult(value: unknown): GitIndexMutationResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'kind', 'status']) ||
    !isUuid(value.operationId)) return undefined
  const kind = parseKind(value.kind)
  const status = parseGitStatusSnapshot(value.status)
  return kind === undefined || status === undefined
    ? undefined
    : { operationId: value.operationId, kind, status }
}
