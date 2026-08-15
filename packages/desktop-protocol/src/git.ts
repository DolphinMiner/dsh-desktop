const MAX_PATH_LENGTH = 4_096
const MAX_SESSION_ID_LENGTH = 256
const MAX_REF_LENGTH = 1_024
const MAX_STATUS_ENTRIES = 20_000

export interface GitRepositoryIdentity {
  root: string
  gitDir: string
  commonDir: string
}

export type GitStatusEntryKind =
  | 'ordinary'
  | 'renamed'
  | 'unmerged'
  | 'untracked'
  | 'ignored'

export interface GitStatusEntry {
  kind: GitStatusEntryKind
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
}

export interface GitStatusSnapshot {
  repository: GitRepositoryIdentity
  head?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  clean: boolean
  entries: GitStatusEntry[]
}

export interface GitDiscoverParams {
  sessionId: string
  workspaceRoot: string
}

export interface GitStatusParams extends GitDiscoverParams {
  repositoryRoot: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function parseRepository(value: unknown): GitRepositoryIdentity | undefined {
  if (!isRecord(value) || !isBoundedString(value.root, MAX_PATH_LENGTH) ||
    !isBoundedString(value.gitDir, MAX_PATH_LENGTH) ||
    !isBoundedString(value.commonDir, MAX_PATH_LENGTH)) return undefined
  return { root: value.root, gitDir: value.gitDir, commonDir: value.commonDir }
}

function parseStatusEntry(value: unknown): GitStatusEntry | undefined {
  if (!isRecord(value) || !isBoundedString(value.path, MAX_PATH_LENGTH) ||
    typeof value.indexStatus !== 'string' || typeof value.worktreeStatus !== 'string') return undefined
  if (value.kind === 'untracked' || value.kind === 'ignored') {
    const marker = value.kind === 'untracked' ? '?' : '!'
    if (value.indexStatus !== marker || value.worktreeStatus !== marker || value.originalPath !== undefined) {
      return undefined
    }
    return {
      kind: value.kind,
      path: value.path,
      indexStatus: marker,
      worktreeStatus: marker,
    }
  }
  if (value.kind !== 'ordinary' && value.kind !== 'renamed' && value.kind !== 'unmerged') return undefined
  if (!/^[.MTADRCU]$/.test(value.indexStatus) || !/^[.MTADRCU]$/.test(value.worktreeStatus)) {
    return undefined
  }
  if (value.kind === 'renamed') {
    if (!isBoundedString(value.originalPath, MAX_PATH_LENGTH)) return undefined
    return {
      kind: value.kind,
      path: value.path,
      originalPath: value.originalPath,
      indexStatus: value.indexStatus,
      worktreeStatus: value.worktreeStatus,
    }
  }
  if (value.originalPath !== undefined) return undefined
  return {
    kind: value.kind,
    path: value.path,
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
  }
}

export function parseGitDiscoverParams(value: unknown): GitDiscoverParams | undefined {
  if (!isRecord(value) || !isBoundedString(value.sessionId, MAX_SESSION_ID_LENGTH) ||
    !isBoundedString(value.workspaceRoot, MAX_PATH_LENGTH)) return undefined
  return { sessionId: value.sessionId, workspaceRoot: value.workspaceRoot }
}

export function parseGitStatusParams(value: unknown): GitStatusParams | undefined {
  const base = parseGitDiscoverParams(value)
  if (base === undefined || !isRecord(value) || !isBoundedString(value.repositoryRoot, MAX_PATH_LENGTH)) {
    return undefined
  }
  return { ...base, repositoryRoot: value.repositoryRoot }
}

export function parseGitRepositoryIdentity(value: unknown): GitRepositoryIdentity | undefined {
  return parseRepository(value)
}

export function parseGitStatusSnapshot(value: unknown): GitStatusSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const repository = parseRepository(value.repository)
  if (repository === undefined || !Number.isSafeInteger(value.ahead) || Number(value.ahead) < 0 ||
    !Number.isSafeInteger(value.behind) || Number(value.behind) < 0 || typeof value.clean !== 'boolean' ||
    !Array.isArray(value.entries) || value.entries.length > MAX_STATUS_ENTRIES) return undefined
  if (value.head !== undefined && (typeof value.head !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head))) return undefined
  if (value.branch !== undefined && !isBoundedString(value.branch, MAX_REF_LENGTH)) return undefined
  if (value.upstream !== undefined && !isBoundedString(value.upstream, MAX_REF_LENGTH)) return undefined
  if (value.upstream === undefined && (Number(value.ahead) !== 0 || Number(value.behind) !== 0)) return undefined
  const entries = value.entries.map(parseStatusEntry)
  if (entries.some(entry => entry === undefined) || value.clean !== (entries.length === 0)) return undefined
  return {
    repository,
    ...(value.head === undefined ? {} : { head: value.head }),
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    ...(value.upstream === undefined ? {} : { upstream: value.upstream }),
    ahead: Number(value.ahead),
    behind: Number(value.behind),
    clean: value.clean,
    entries: entries as GitStatusEntry[],
  }
}
