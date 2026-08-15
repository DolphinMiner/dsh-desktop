const MAX_PATH_LENGTH = 4_096
const MAX_SESSION_ID_LENGTH = 256
const MAX_REF_LENGTH = 1_024
const MAX_STATUS_ENTRIES = 20_000
const MAX_PATCH_LENGTH = 2 * 1024 * 1024

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

export type GitReviewScope =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'completed-turn' }
  | { kind: 'commit'; ref: string }
  | { kind: 'branch'; baseRef: string }

export interface GitReviewParams extends GitStatusParams {
  scope: GitReviewScope
}

export interface DesktopGitReviewInput extends GitDiscoverParams {
  scope: GitReviewScope
}

export type GitReviewFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unmerged'
  | 'untracked'

export interface GitReviewFile {
  status: GitReviewFileStatus
  path: string
  originalPath?: string
  patchAvailable: boolean
}

export interface GitReviewTurnAttribution {
  sessionId: string
  turn: number
  startEventSeq: number
  endEventSeq: number
  startedAt: string
  completedAt: string
}

export interface GitReviewSnapshot {
  repository: GitRepositoryIdentity
  scope: GitReviewScope
  head?: string
  selectedCommit?: string
  baseCommit?: string
  mergeBase?: string
  fromTree?: string
  toTree?: string
  attributedTurn?: GitReviewTurnAttribution
  files: GitReviewFile[]
  patch: string
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

export function parseGitStatusEntry(value: unknown): GitStatusEntry | undefined {
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

export function parseGitReviewScope(value: unknown): GitReviewScope | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'unstaged' || value.kind === 'staged' || value.kind === 'completed-turn') {
    return Object.keys(value).length === 1 ? { kind: value.kind } : undefined
  }
  if (value.kind === 'commit' && isBoundedString(value.ref, MAX_REF_LENGTH) &&
    !/[\r\n]/.test(value.ref) && Object.keys(value).length === 2) {
    return { kind: value.kind, ref: value.ref }
  }
  if (value.kind === 'branch' && isBoundedString(value.baseRef, MAX_REF_LENGTH) &&
    !/[\r\n]/.test(value.baseRef) && Object.keys(value).length === 2) {
    return { kind: value.kind, baseRef: value.baseRef }
  }
  return undefined
}

function parseTurnAttribution(value: unknown): GitReviewTurnAttribution | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => ![
    'sessionId', 'turn', 'startEventSeq', 'endEventSeq', 'startedAt', 'completedAt',
  ].includes(key)) || Object.keys(value).length !== 6 ||
    !isBoundedString(value.sessionId, MAX_SESSION_ID_LENGTH) ||
    !Number.isSafeInteger(value.turn) || Number(value.turn) < 0 ||
    !Number.isSafeInteger(value.startEventSeq) || Number(value.startEventSeq) < 0 ||
    !Number.isSafeInteger(value.endEventSeq) || Number(value.endEventSeq) <= Number(value.startEventSeq) ||
    typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value.completedAt !== 'string' || Number.isNaN(Date.parse(value.completedAt)) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt)) return undefined
  return {
    sessionId: value.sessionId,
    turn: Number(value.turn),
    startEventSeq: Number(value.startEventSeq),
    endEventSeq: Number(value.endEventSeq),
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  }
}

function parseReviewFile(value: unknown): GitReviewFile | undefined {
  if (!isRecord(value) || !isBoundedString(value.path, MAX_PATH_LENGTH) ||
    typeof value.patchAvailable !== 'boolean' ||
    (value.status !== 'added' && value.status !== 'modified' && value.status !== 'deleted' &&
      value.status !== 'renamed' && value.status !== 'copied' && value.status !== 'type-changed' &&
      value.status !== 'unmerged' && value.status !== 'untracked')) return undefined
  if (value.status === 'renamed' || value.status === 'copied') {
    if (!isBoundedString(value.originalPath, MAX_PATH_LENGTH)) return undefined
  } else if (value.originalPath !== undefined) return undefined
  if (value.status === 'untracked' && value.patchAvailable) return undefined
  return {
    status: value.status,
    path: value.path,
    ...(value.originalPath === undefined ? {} : { originalPath: value.originalPath }),
    patchAvailable: value.patchAvailable,
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

export function parseGitReviewParams(value: unknown): GitReviewParams | undefined {
  const base = parseGitStatusParams(value)
  if (base === undefined || !isRecord(value)) return undefined
  const scope = parseGitReviewScope(value.scope)
  return scope === undefined ? undefined : { ...base, scope }
}

export function parseDesktopGitReviewInput(value: unknown): DesktopGitReviewInput | undefined {
  const base = parseGitDiscoverParams(value)
  if (base === undefined || !isRecord(value)) return undefined
  const scope = parseGitReviewScope(value.scope)
  return scope === undefined ? undefined : { ...base, scope }
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
  const entries = value.entries.map(parseGitStatusEntry)
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

export function parseGitReviewSnapshot(value: unknown): GitReviewSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const repository = parseRepository(value.repository)
  const scope = parseGitReviewScope(value.scope)
  if (repository === undefined || scope === undefined || !Array.isArray(value.files) ||
    value.files.length > MAX_STATUS_ENTRIES || typeof value.patch !== 'string' ||
    value.patch.length > MAX_PATCH_LENGTH || value.patch.includes('\0')) return undefined
  const commitFields = ['head', 'selectedCommit', 'baseCommit', 'mergeBase'] as const
  if (commitFields.some(field => value[field] !== undefined &&
    (typeof value[field] !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[field] as string)))) {
    return undefined
  }
  const hasSelectedCommit = value.selectedCommit !== undefined
  const hasBaseCommit = value.baseCommit !== undefined
  const hasMergeBase = value.mergeBase !== undefined
  const fromTree = value.fromTree
  const toTree = value.toTree
  const attributedTurn = value.attributedTurn === undefined ? undefined : parseTurnAttribution(value.attributedTurn)
  const hasTurnFields = fromTree !== undefined || toTree !== undefined || value.attributedTurn !== undefined
  if (scope.kind === 'commit') {
    if (!hasSelectedCommit || hasBaseCommit || hasMergeBase || hasTurnFields) return undefined
  } else if (scope.kind === 'branch') {
    if (hasSelectedCommit || !hasBaseCommit || !hasMergeBase || hasTurnFields) return undefined
  } else if (scope.kind === 'completed-turn') {
    if (hasSelectedCommit || hasBaseCommit || hasMergeBase ||
      typeof fromTree !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fromTree) ||
      typeof toTree !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(toTree) ||
      attributedTurn === undefined) return undefined
  } else if (hasSelectedCommit || hasBaseCommit || hasMergeBase || hasTurnFields) return undefined
  const files = value.files.map(parseReviewFile)
  if (files.some(file => file === undefined) ||
    new Set((files as GitReviewFile[]).map(file => file.path)).size !== files.length) return undefined
  return {
    repository,
    scope,
    ...(value.head === undefined ? {} : { head: value.head as string }),
    ...(value.selectedCommit === undefined ? {} : { selectedCommit: value.selectedCommit as string }),
    ...(value.baseCommit === undefined ? {} : { baseCommit: value.baseCommit as string }),
    ...(value.mergeBase === undefined ? {} : { mergeBase: value.mergeBase as string }),
    ...(fromTree === undefined ? {} : { fromTree: fromTree as string }),
    ...(toTree === undefined ? {} : { toTree: toTree as string }),
    ...(attributedTurn === undefined ? {} : { attributedTurn }),
    files: files as GitReviewFile[],
    patch: value.patch,
  }
}
