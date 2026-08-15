import { isAbsolute, normalize } from 'node:path'

import {
  parseGitRepositoryIdentity,
  parseMovedWorktreeRecoveryInspection,
  type GitRepositoryIdentity,
  type MovedWorktreeRecoveryInspection,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const WORKTREE_RELOCATION_JOURNAL_SCHEMA_VERSION = 1 as const
const MAX_OPERATIONS = 10_000
const MAX_PATH_LENGTH = 4_096

export type WorktreeRelocationPhase =
  | 'intent'
  | 'dispatch'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ambiguous'

export type WorktreeRelocationReason =
  | 'completed'
  | 'not-applied'
  | 'result-ambiguous'
  | 'cancelled-before-dispatch'
  | 'interrupted-before-dispatch'
  | 'interrupted-after-dispatch'
  | 'reconciled-completed'
  | 'reconciled-not-applied'

export interface WorktreeRelocationEvent {
  phase: WorktreeRelocationPhase
  at: string
  reason?: WorktreeRelocationReason
}

export interface WorktreeRelocationRecord {
  operationId: string
  worktreeId: string
  repository: GitRepositoryIdentity
  inspection: MovedWorktreeRecoveryInspection
  fingerprint: string
  events: WorktreeRelocationEvent[]
}

export type BeginWorktreeRelocationInput = Omit<WorktreeRelocationRecord, 'events'>

interface WorktreeRelocationDocument {
  schemaVersion: typeof WORKTREE_RELOCATION_JOURNAL_SCHEMA_VERSION
  revision: number
  operations: WorktreeRelocationRecord[]
}

export interface WorktreeRelocationJournalOptions {
  now?: () => Date
  maxOperations?: number
  write?: typeof writeJsonAtomically
}

export class WorktreeRelocationJournalError extends Error {
  constructor(
    readonly code: 'BAD_MESSAGE' | 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'WorktreeRelocationJournalError'
  }
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

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') && isAbsolute(value) && normalize(value) === value
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

function isPhase(value: unknown): value is WorktreeRelocationPhase {
  return value === 'intent' || value === 'dispatch' || value === 'succeeded' || value === 'failed' ||
    value === 'cancelled' || value === 'ambiguous'
}

function isReason(value: unknown): value is WorktreeRelocationReason {
  return value === 'completed' || value === 'not-applied' || value === 'result-ambiguous' ||
    value === 'cancelled-before-dispatch' || value === 'interrupted-before-dispatch' ||
    value === 'interrupted-after-dispatch' || value === 'reconciled-completed' ||
    value === 'reconciled-not-applied'
}

function outcomeMatches(phase: WorktreeRelocationPhase, reason: WorktreeRelocationReason | undefined): boolean {
  if (phase === 'succeeded') return reason === 'completed' || reason === 'reconciled-completed'
  if (phase === 'failed') return reason === 'not-applied' || reason === 'reconciled-not-applied'
  if (phase === 'cancelled') {
    return reason === 'cancelled-before-dispatch' || reason === 'interrupted-before-dispatch'
  }
  if (phase === 'ambiguous') {
    return reason === 'result-ambiguous' || reason === 'interrupted-after-dispatch'
  }
  return reason === undefined
}

function parseEvent(value: unknown): WorktreeRelocationEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['phase', 'at', 'reason']) || !isPhase(value.phase) ||
    !isIsoDate(value.at) || (value.reason !== undefined && !isReason(value.reason)) ||
    !outcomeMatches(value.phase, value.reason as WorktreeRelocationReason | undefined)) return undefined
  return {
    phase: value.phase,
    at: value.at,
    ...(value.reason === undefined ? {} : { reason: value.reason as WorktreeRelocationReason }),
  }
}

function canTransition(from: WorktreeRelocationPhase, to: WorktreeRelocationPhase): boolean {
  if (from === 'intent') return to === 'dispatch' || to === 'cancelled'
  if (from === 'dispatch') return to === 'succeeded' || to === 'failed' || to === 'ambiguous'
  return from === 'ambiguous' && (to === 'succeeded' || to === 'failed')
}

function transitionMatches(
  from: WorktreeRelocationPhase,
  to: WorktreeRelocationPhase,
  reason: WorktreeRelocationReason | undefined,
): boolean {
  if (from === 'intent') {
    return (to === 'dispatch' && reason === undefined) ||
      (to === 'cancelled' &&
        (reason === 'cancelled-before-dispatch' || reason === 'interrupted-before-dispatch'))
  }
  if (from === 'dispatch') {
    return (to === 'succeeded' && reason === 'completed') ||
      (to === 'failed' && reason === 'not-applied') ||
      (to === 'ambiguous' && (reason === 'result-ambiguous' || reason === 'interrupted-after-dispatch'))
  }
  return from === 'ambiguous' &&
    ((to === 'succeeded' && reason === 'reconciled-completed') ||
      (to === 'failed' && reason === 'reconciled-not-applied'))
}

function validEvents(events: readonly WorktreeRelocationEvent[]): boolean {
  if (events.length === 0 || events[0]?.phase !== 'intent') return false
  for (let index = 1; index < events.length; index += 1) {
    if (!canTransition(events[index - 1]!.phase, events[index]!.phase) ||
      !transitionMatches(events[index - 1]!.phase, events[index]!.phase, events[index]!.reason) ||
      Date.parse(events[index]!.at) < Date.parse(events[index - 1]!.at)) return false
  }
  return true
}

function parseOperation(value: unknown): WorktreeRelocationRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'operationId', 'worktreeId', 'repository', 'inspection', 'fingerprint', 'events',
  ]) || !isUuid(value.operationId) || !isUuid(value.worktreeId) ||
    !isRecord(value.repository) || !hasOnlyKeys(value.repository, ['root', 'gitDir', 'commonDir']) ||
    !isFingerprint(value.fingerprint) || !Array.isArray(value.events) || value.events.length === 0) return undefined
  const repository = parseGitRepositoryIdentity(value.repository)
  const inspection = parseMovedWorktreeRecoveryInspection(value.inspection)
  const events = value.events.map(parseEvent)
  if (repository === undefined || inspection === undefined || repository.root !== inspection.repositoryRoot ||
    !isCanonicalAbsolutePath(repository.root) || !isCanonicalAbsolutePath(repository.gitDir) ||
    !isCanonicalAbsolutePath(repository.commonDir) || !isCanonicalAbsolutePath(inspection.repositoryRoot) ||
    !isCanonicalAbsolutePath(inspection.registeredPath) ||
    !isCanonicalAbsolutePath(inspection.current.worktreePath) ||
    events.some(event => event === undefined) || !validEvents(events as WorktreeRelocationEvent[])) return undefined
  return {
    operationId: value.operationId,
    worktreeId: value.worktreeId,
    repository,
    inspection,
    fingerprint: value.fingerprint,
    events: events as WorktreeRelocationEvent[],
  }
}

function emptyDocument(): WorktreeRelocationDocument {
  return { schemaVersion: WORKTREE_RELOCATION_JOURNAL_SCHEMA_VERSION, revision: 0, operations: [] }
}

function parseDocument(value: unknown): WorktreeRelocationDocument {
  if (value === undefined) return emptyDocument()
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'operations']) ||
    value.schemaVersion !== WORKTREE_RELOCATION_JOURNAL_SCHEMA_VERSION || !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw new Error('The worktree relocation journal uses an unsupported or invalid document shape.')
  }
  const operations = value.operations.map(parseOperation)
  if (operations.some(operation => operation === undefined)) {
    throw new Error('The worktree relocation journal contains an invalid operation.')
  }
  const parsed = operations as WorktreeRelocationRecord[]
  if (new Set(parsed.map(operation => operation.operationId)).size !== parsed.length) {
    throw new Error('The worktree relocation journal contains duplicate operation identifiers.')
  }
  const unresolved = parsed.filter(operation => !terminal(worktreeRelocationPhase(operation)))
  if (new Set(unresolved.map(operation => operation.worktreeId)).size !== unresolved.length) {
    throw new Error('The worktree relocation journal contains overlapping unresolved operations.')
  }
  return {
    schemaVersion: WORKTREE_RELOCATION_JOURNAL_SCHEMA_VERSION,
    revision: Number(value.revision),
    operations: parsed,
  }
}

function cloneInspection(inspection: MovedWorktreeRecoveryInspection): MovedWorktreeRecoveryInspection {
  const current = inspection.current.clean
    ? { ...inspection.current, changes: [] as [] }
    : { ...inspection.current, changes: inspection.current.changes.map(change => ({ ...change })) }
  return {
    ...inspection,
    current,
  }
}

function cloneOperation(operation: WorktreeRelocationRecord): WorktreeRelocationRecord {
  return {
    ...operation,
    repository: { ...operation.repository },
    inspection: cloneInspection(operation.inspection),
    events: operation.events.map(event => ({ ...event })),
  }
}

function sameInspection(
  left: MovedWorktreeRecoveryInspection,
  right: MovedWorktreeRecoveryInspection,
): boolean {
  return left.repositoryRoot === right.repositoryRoot && left.registeredPath === right.registeredPath &&
    left.registeredPathAbsent === right.registeredPathAbsent &&
    left.current.worktreePath === right.current.worktreePath && left.current.head === right.current.head &&
    left.current.branch === right.current.branch && left.current.clean === right.current.clean &&
    left.current.locked === right.current.locked && left.current.changes.length === right.current.changes.length &&
    left.current.changes.every((change, index) => {
      const other = right.current.changes[index]
      return other !== undefined && change.kind === other.kind && change.path === other.path &&
        change.originalPath === other.originalPath && change.indexStatus === other.indexStatus &&
        change.worktreeStatus === other.worktreeStatus
    })
}

function matches(operation: WorktreeRelocationRecord, input: BeginWorktreeRelocationInput): boolean {
  return operation.worktreeId === input.worktreeId &&
    operation.repository.root === input.repository.root && operation.repository.gitDir === input.repository.gitDir &&
    operation.repository.commonDir === input.repository.commonDir &&
    operation.fingerprint === input.fingerprint && sameInspection(operation.inspection, input.inspection)
}

function terminal(phase: WorktreeRelocationPhase): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled'
}

export function worktreeRelocationPhase(operation: WorktreeRelocationRecord): WorktreeRelocationPhase {
  return operation.events.at(-1)!.phase
}

export class WorktreeRelocationJournal {
  private state = emptyDocument()
  private available = true
  private unavailableReason?: string
  private readonly now: () => Date
  private readonly maxOperations: number
  private readonly write: typeof writeJsonAtomically

  constructor(
    private readonly path: string,
    options: WorktreeRelocationJournalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.maxOperations = Math.max(1, Math.min(options.maxOperations ?? MAX_OPERATIONS, MAX_OPERATIONS))
    this.write = options.write ?? writeJsonAtomically
    try {
      this.state = parseDocument(readJsonFile(path))
      this.recoverInterrupted()
    } catch {
      this.available = false
      this.unavailableReason = 'The worktree relocation journal could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  list(): WorktreeRelocationRecord[] {
    this.assertAvailable()
    return this.state.operations.map(cloneOperation)
  }

  get(operationId: string): WorktreeRelocationRecord | undefined {
    this.assertAvailable()
    const operation = this.state.operations.find(candidate => candidate.operationId === operationId)
    return operation === undefined ? undefined : cloneOperation(operation)
  }

  begin(input: BeginWorktreeRelocationInput): { created: boolean; operation: WorktreeRelocationRecord } {
    this.assertAvailable()
    const parsed = parseOperation({
      ...input,
      events: [{ phase: 'intent', at: this.now().toISOString() }],
    })
    if (parsed === undefined) {
      throw new WorktreeRelocationJournalError('BAD_MESSAGE', 'The worktree relocation intent is invalid.')
    }
    const existing = this.state.operations.find(operation => operation.operationId === input.operationId)
    if (existing !== undefined) {
      if (!matches(existing, input)) {
        throw new WorktreeRelocationJournalError(
          'DUPLICATE_REQUEST',
          'The relocation identifier was already used for another reviewed checkout.',
        )
      }
      return { created: false, operation: cloneOperation(existing) }
    }
    if (this.state.operations.some(operation => operation.worktreeId === input.worktreeId &&
      !terminal(worktreeRelocationPhase(operation)))) {
      throw new WorktreeRelocationJournalError(
        'DUPLICATE_REQUEST',
        'This managed worktree already has an unresolved relocation operation.',
      )
    }
    this.commit(next => {
      while (next.operations.length >= this.maxOperations) {
        const index = next.operations.findIndex(operation => terminal(worktreeRelocationPhase(operation)))
        if (index < 0) {
          throw new WorktreeRelocationJournalError(
            'DESKTOP_UNAVAILABLE',
            'The worktree relocation journal is full of unresolved operations.',
          )
        }
        next.operations.splice(index, 1)
      }
      next.operations.push(parsed)
    })
    return { created: true, operation: cloneOperation(parsed) }
  }

  recordDispatch(operationId: string): WorktreeRelocationRecord {
    return this.transition(operationId, 'dispatch')
  }

  recordCancellation(
    operationId: string,
    reason: 'cancelled-before-dispatch' | 'interrupted-before-dispatch' = 'cancelled-before-dispatch',
  ): WorktreeRelocationRecord {
    return this.transition(operationId, 'cancelled', reason)
  }

  recordOutcome(
    operationId: string,
    phase: 'succeeded' | 'failed' | 'ambiguous',
    reason: WorktreeRelocationReason,
  ): WorktreeRelocationRecord {
    return this.transition(operationId, phase, reason)
  }

  private recoverInterrupted(): void {
    if (!this.state.operations.some(operation => {
      const phase = worktreeRelocationPhase(operation)
      return phase === 'intent' || phase === 'dispatch'
    })) return
    this.commit(next => {
      for (const operation of next.operations) {
        const phase = worktreeRelocationPhase(operation)
        if (phase === 'intent') {
          operation.events.push({
            phase: 'cancelled',
            at: this.nextTime(operation),
            reason: 'interrupted-before-dispatch',
          })
        } else if (phase === 'dispatch') {
          operation.events.push({
            phase: 'ambiguous',
            at: this.nextTime(operation),
            reason: 'interrupted-after-dispatch',
          })
        }
      }
    })
  }

  private transition(
    operationId: string,
    phase: WorktreeRelocationPhase,
    reason?: WorktreeRelocationReason,
  ): WorktreeRelocationRecord {
    this.assertAvailable()
    let result: WorktreeRelocationRecord | undefined
    this.commit(next => {
      const operation = next.operations.find(candidate => candidate.operationId === operationId)
      if (operation === undefined) {
        throw new WorktreeRelocationJournalError('NOT_FOUND', 'The worktree relocation operation was not found.')
      }
      const current = worktreeRelocationPhase(operation)
      if (!canTransition(current, phase) || !transitionMatches(current, phase, reason)) {
        throw new WorktreeRelocationJournalError(
          'DUPLICATE_REQUEST',
          'The worktree relocation operation cannot enter the requested phase.',
        )
      }
      operation.events.push({ phase, at: this.nextTime(operation), ...(reason === undefined ? {} : { reason }) })
      result = cloneOperation(operation)
    })
    return result!
  }

  private nextTime(operation: WorktreeRelocationRecord): string {
    const previous = Date.parse(operation.events.at(-1)!.at)
    return new Date(Math.max(this.now().getTime(), previous)).toISOString()
  }

  private commit(change: (next: WorktreeRelocationDocument) => void): void {
    this.assertAvailable()
    const next: WorktreeRelocationDocument = {
      schemaVersion: WORKTREE_RELOCATION_JOURNAL_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      operations: this.state.operations.map(cloneOperation),
    }
    change(next)
    try {
      this.write(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof WorktreeRelocationJournalError) throw error
      this.available = false
      this.unavailableReason = 'The worktree relocation journal could not be persisted safely.'
      throw new WorktreeRelocationJournalError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
  }

  private assertAvailable(): void {
    if (this.available) return
    throw new WorktreeRelocationJournalError(
      'DESKTOP_UNAVAILABLE',
      this.unavailableReason ?? 'The worktree relocation journal is unavailable.',
    )
  }
}
