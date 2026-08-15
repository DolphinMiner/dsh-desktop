const MAX_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024
const MAX_WORKTREES = 10_000

export type WorktreeExecutionMode = 'local' | 'worktree'
export type WorktreeLifecycle =
  | 'provisioning'
  | 'ready'
  | 'removing'
  | 'recovery-required'
  | 'orphaned'
  | 'removed'
export type WorktreeRecoveryReason =
  | 'create-ambiguous'
  | 'interrupted-create'
  | 'interrupted-remove'
  | 'inspection-failed'
  | 'external-change'
  | 'locked'
  | 'missing'
  | 'moved'

export interface WorktreeProvisionParams {
  operationId: string
  requestedBySessionId: string
  workspaceRoot: string
  baseRef: string
}

export interface WorktreeSessionBindingParams {
  sessionId: string
  workspacePath: string
}

export interface WorktreeSummary {
  id: string
  repositoryRoot: string
  requestedBySessionId: string
  sessionState: 'pending' | 'bound'
  sessionId?: string
  executionMode: WorktreeExecutionMode
  worktreePath?: string
  baseRef: string
  baseCommit: string
  branch?: string
  lifecycle: WorktreeLifecycle
  recoveryReason?: WorktreeRecoveryReason
  createdAt: string
  updatedAt: string
}

export interface WorktreeSessionBindingResult {
  managed: boolean
  worktree?: WorktreeSummary
}

export interface WorktreeSnapshot {
  revision: number
  worktrees: WorktreeSummary[]
}

export interface WorktreeChangedEvent {
  revision: number
  worktree: WorktreeSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isUuid(value: unknown): value is string {
  return isBoundedString(value, 36) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

function isLifecycle(value: unknown): value is WorktreeLifecycle {
  return value === 'provisioning' || value === 'ready' || value === 'removing' ||
    value === 'recovery-required' || value === 'orphaned' || value === 'removed'
}

function isRecoveryReason(value: unknown): value is WorktreeRecoveryReason {
  return value === 'create-ambiguous' || value === 'interrupted-create' ||
    value === 'interrupted-remove' || value === 'inspection-failed' ||
    value === 'external-change' || value === 'locked' ||
    value === 'missing' || value === 'moved'
}

export function parseWorktreeProvisionParams(value: unknown): WorktreeProvisionParams | undefined {
  if (!isRecord(value) || !isBoundedString(value.operationId, MAX_ID_LENGTH) ||
    !isBoundedString(value.requestedBySessionId, MAX_ID_LENGTH) ||
    !isBoundedString(value.workspaceRoot, MAX_PATH_LENGTH) ||
    !isBoundedString(value.baseRef, MAX_REF_LENGTH) || /[\r\n]/.test(value.baseRef)) return undefined
  return {
    operationId: value.operationId,
    requestedBySessionId: value.requestedBySessionId,
    workspaceRoot: value.workspaceRoot,
    baseRef: value.baseRef,
  }
}

export function parseWorktreeSessionBindingParams(value: unknown): WorktreeSessionBindingParams | undefined {
  if (!isRecord(value) || !isBoundedString(value.sessionId, MAX_ID_LENGTH) ||
    !isBoundedString(value.workspacePath, MAX_PATH_LENGTH)) return undefined
  return { sessionId: value.sessionId, workspacePath: value.workspacePath }
}

export function parseWorktreeSummary(value: unknown): WorktreeSummary | undefined {
  if (!isRecord(value) || !isUuid(value.id) || !isBoundedString(value.repositoryRoot, MAX_PATH_LENGTH) ||
    !isBoundedString(value.requestedBySessionId, MAX_ID_LENGTH) ||
    (value.sessionState !== 'pending' && value.sessionState !== 'bound') ||
    (value.executionMode !== 'local' && value.executionMode !== 'worktree') ||
    !isBoundedString(value.baseRef, MAX_REF_LENGTH) || /[\r\n]/.test(value.baseRef) ||
    !isCommit(value.baseCommit) ||
    !isLifecycle(value.lifecycle) || !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return undefined
  if (value.sessionState === 'bound') {
    if (!isBoundedString(value.sessionId, MAX_ID_LENGTH)) return undefined
  } else if (value.sessionId !== undefined) return undefined
  if (value.executionMode === 'worktree') {
    if (!isBoundedString(value.worktreePath, MAX_PATH_LENGTH)) return undefined
  } else if (value.worktreePath !== undefined) return undefined
  if (value.branch !== undefined &&
    (!isBoundedString(value.branch, MAX_REF_LENGTH) || /[\r\n]/.test(value.branch))) return undefined
  if (value.lifecycle === 'recovery-required') {
    if (!isRecoveryReason(value.recoveryReason)) return undefined
  } else if (value.recoveryReason !== undefined) return undefined
  return {
    id: value.id,
    repositoryRoot: value.repositoryRoot,
    requestedBySessionId: value.requestedBySessionId,
    sessionState: value.sessionState,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    executionMode: value.executionMode,
    ...(value.worktreePath === undefined ? {} : { worktreePath: value.worktreePath }),
    baseRef: value.baseRef,
    baseCommit: value.baseCommit,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    lifecycle: value.lifecycle,
    ...(value.recoveryReason === undefined ? {} : { recoveryReason: value.recoveryReason }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

export function parseWorktreeSessionBindingResult(value: unknown): WorktreeSessionBindingResult | undefined {
  if (!isRecord(value) || typeof value.managed !== 'boolean') return undefined
  if (!value.managed) return value.worktree === undefined ? { managed: false } : undefined
  const worktree = parseWorktreeSummary(value.worktree)
  return worktree === undefined ? undefined : { managed: true, worktree }
}

export function parseWorktreeSnapshot(value: unknown): WorktreeSnapshot | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.worktrees) || value.worktrees.length > MAX_WORKTREES) return undefined
  const worktrees = value.worktrees.map(parseWorktreeSummary)
  if (worktrees.some(worktree => worktree === undefined)) return undefined
  const summaries = worktrees as WorktreeSummary[]
  const active = summaries.filter(worktree => worktree.lifecycle !== 'removed')
  const checkoutPaths = active.map(worktree =>
    worktree.executionMode === 'local' ? worktree.repositoryRoot : worktree.worktreePath!)
  const requestingSessions = active.map(worktree => worktree.requestedBySessionId)
  const boundSessions = active.flatMap(worktree => worktree.sessionId === undefined ? [] : [worktree.sessionId])
  if (new Set(summaries.map(worktree => worktree.id)).size !== summaries.length ||
    new Set(checkoutPaths).size !== checkoutPaths.length ||
    new Set(requestingSessions).size !== requestingSessions.length ||
    new Set(boundSessions).size !== boundSessions.length) return undefined
  return { revision: Number(value.revision), worktrees: summaries }
}

export function parseWorktreeChangedEvent(value: unknown): WorktreeChangedEvent | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  return worktree === undefined ? undefined : { revision: Number(value.revision), worktree }
}
