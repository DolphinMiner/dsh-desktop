import { isAbsolute, normalize } from 'node:path'

import type {
  WorktreeHandoffDirection,
  WorktreeHandoffEndpoint,
  WorktreeHandoffFile,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const WORKTREE_HANDOFF_JOURNAL_SCHEMA_VERSION = 1 as const
const MAX_OPERATIONS = 10_000
const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024
const MAX_FILES = 10_000
const MAX_TOTAL_FILE_PATH_LENGTH = 1024 * 1024

export type WorktreeHandoffOperationPhase =
  | 'intent'
  | 'dispatch'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ambiguous'

export type WorktreeHandoffOperationReason =
  | 'completed'
  | 'not-applied'
  | 'result-ambiguous'
  | 'cancelled-before-dispatch'
  | 'interrupted-before-dispatch'
  | 'interrupted-after-dispatch'
  | 'reconciled-completed'
  | 'reconciled-not-applied'

export interface WorktreeHandoffOperationEvent {
  phase: WorktreeHandoffOperationPhase
  at: string
  reason?: WorktreeHandoffOperationReason
}

export interface WorktreeHandoffOperationRecord {
  operationId: string
  worktreeId: string
  direction: WorktreeHandoffDirection
  repositoryRoot: string
  repositoryCommonDir: string
  worktreePath: string
  branch: string
  baseCommit: string
  sourceTree: string
  source: WorktreeHandoffEndpoint
  destination: WorktreeHandoffEndpoint
  files: WorktreeHandoffFile[]
  patchFingerprint: string
  approvalFingerprint: string
  events: WorktreeHandoffOperationEvent[]
}

export type BeginWorktreeHandoffOperationInput = Omit<WorktreeHandoffOperationRecord, 'events'>

interface WorktreeHandoffJournalDocument {
  schemaVersion: typeof WORKTREE_HANDOFF_JOURNAL_SCHEMA_VERSION
  revision: number
  operations: WorktreeHandoffOperationRecord[]
}

export interface WorktreeHandoffJournalOptions {
  now?: () => Date
  maxOperations?: number
  write?: typeof writeJsonAtomically
}

export class WorktreeHandoffJournalError extends Error {
  constructor(
    readonly code: 'BAD_MESSAGE' | 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'WorktreeHandoffJournalError'
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

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return isBoundedString(value, MAX_PATH_LENGTH) && isAbsolute(value) && normalize(value) === value
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

function isDirection(value: unknown): value is WorktreeHandoffDirection {
  return value === 'local-to-worktree' || value === 'worktree-to-local'
}

function parseEndpoint(value: unknown): WorktreeHandoffEndpoint | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'path', 'branch', 'head', 'clean']) ||
    (value.kind !== 'local' && value.kind !== 'worktree') || !isCanonicalAbsolutePath(value.path) ||
    !isObjectId(value.head) || typeof value.clean !== 'boolean' ||
    (value.branch !== undefined && (!isBoundedString(value.branch, MAX_REF_LENGTH) || /[\r\n]/.test(value.branch)))) {
    return undefined
  }
  return {
    kind: value.kind,
    path: value.path,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    head: value.head,
    clean: value.clean,
  }
}

function isFileStatus(value: unknown): value is WorktreeHandoffFile['status'] {
  return value === 'added' || value === 'modified' || value === 'deleted' || value === 'renamed' ||
    value === 'copied' || value === 'type-changed'
}

function parseFile(value: unknown): WorktreeHandoffFile | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'path', 'originalPath', 'patchAvailable']) ||
    !isFileStatus(value.status) || !isBoundedString(value.path, MAX_PATH_LENGTH) || value.patchAvailable !== true ||
    (value.originalPath !== undefined && !isBoundedString(value.originalPath, MAX_PATH_LENGTH)) ||
    ((value.status === 'renamed' || value.status === 'copied') !== (value.originalPath !== undefined))) {
    return undefined
  }
  return {
    status: value.status,
    path: value.path,
    ...(value.originalPath === undefined ? {} : { originalPath: value.originalPath }),
    patchAvailable: true,
  }
}

function isPhase(value: unknown): value is WorktreeHandoffOperationPhase {
  return value === 'intent' || value === 'dispatch' || value === 'succeeded' || value === 'failed' ||
    value === 'cancelled' || value === 'ambiguous'
}

function isReason(value: unknown): value is WorktreeHandoffOperationReason {
  return value === 'completed' || value === 'not-applied' || value === 'result-ambiguous' ||
    value === 'cancelled-before-dispatch' || value === 'interrupted-before-dispatch' ||
    value === 'interrupted-after-dispatch' ||
    value === 'reconciled-completed' || value === 'reconciled-not-applied'
}

function isOutcome(phase: WorktreeHandoffOperationPhase, reason: WorktreeHandoffOperationReason | undefined): boolean {
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

function parseEvent(value: unknown): WorktreeHandoffOperationEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['phase', 'at', 'reason']) || !isPhase(value.phase) ||
    !isIsoDate(value.at) || (value.reason !== undefined && !isReason(value.reason)) ||
    !isOutcome(value.phase, value.reason as WorktreeHandoffOperationReason | undefined)) return undefined
  return {
    phase: value.phase,
    at: value.at,
    ...(value.reason === undefined ? {} : { reason: value.reason as WorktreeHandoffOperationReason }),
  }
}

function canTransition(from: WorktreeHandoffOperationPhase, to: WorktreeHandoffOperationPhase): boolean {
  if (from === 'intent') return to === 'dispatch' || to === 'cancelled'
  if (from === 'dispatch') return to === 'succeeded' || to === 'failed' || to === 'ambiguous'
  return from === 'ambiguous' && (to === 'succeeded' || to === 'failed')
}

function transitionMatchesReason(
  from: WorktreeHandoffOperationPhase,
  to: WorktreeHandoffOperationPhase,
  reason: WorktreeHandoffOperationReason | undefined,
): boolean {
  if (from === 'intent') return (to === 'dispatch' && reason === undefined) ||
    (to === 'cancelled' &&
      (reason === 'cancelled-before-dispatch' || reason === 'interrupted-before-dispatch'))
  if (from === 'dispatch') {
    return (to === 'succeeded' && reason === 'completed') ||
      (to === 'failed' && reason === 'not-applied') ||
      (to === 'ambiguous' && (reason === 'result-ambiguous' || reason === 'interrupted-after-dispatch'))
  }
  return from === 'ambiguous' &&
    ((to === 'succeeded' && reason === 'reconciled-completed') ||
      (to === 'failed' && reason === 'reconciled-not-applied'))
}

function isTerminal(phase: WorktreeHandoffOperationPhase): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled' || phase === 'ambiguous'
}

function validEventChain(events: readonly WorktreeHandoffOperationEvent[]): boolean {
  if (events.length === 0 || events[0]?.phase !== 'intent') return false
  for (let index = 1; index < events.length; index += 1) {
    if (!canTransition(events[index - 1]!.phase, events[index]!.phase) ||
      !transitionMatchesReason(events[index - 1]!.phase, events[index]!.phase, events[index]!.reason) ||
      Date.parse(events[index]!.at) < Date.parse(events[index - 1]!.at)) return false
  }
  return true
}

function parseOperation(value: unknown): WorktreeHandoffOperationRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'operationId', 'worktreeId', 'direction', 'repositoryRoot', 'repositoryCommonDir', 'worktreePath', 'branch',
    'baseCommit', 'sourceTree', 'source', 'destination', 'files', 'patchFingerprint', 'approvalFingerprint', 'events',
  ]) || !isUuid(value.operationId) || !isUuid(value.worktreeId) || !isDirection(value.direction) ||
    !isCanonicalAbsolutePath(value.repositoryRoot) || !isCanonicalAbsolutePath(value.repositoryCommonDir) ||
    !isCanonicalAbsolutePath(value.worktreePath) || value.worktreePath === value.repositoryRoot ||
    !isBoundedString(value.branch, MAX_REF_LENGTH) || !value.branch.startsWith('refs/heads/') ||
    /[\r\n]/.test(value.branch) || !isObjectId(value.baseCommit) || !isObjectId(value.sourceTree) ||
    !isFingerprint(value.patchFingerprint) || !isFingerprint(value.approvalFingerprint) ||
    !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES ||
    !Array.isArray(value.events) || value.events.length === 0) return undefined
  const source = parseEndpoint(value.source)
  const destination = parseEndpoint(value.destination)
  const files = value.files.map(parseFile)
  const events = value.events.map(parseEvent)
  if (source === undefined || destination === undefined || files.some(file => file === undefined) ||
    events.some(event => event === undefined)) return undefined
  const parsedFiles = files as WorktreeHandoffFile[]
  const parsedEvents = events as WorktreeHandoffOperationEvent[]
  const filePaths = parsedFiles.flatMap(file => [file.path, ...(file.originalPath === undefined ? [] : [file.originalPath])])
  const worktreeBranch = value.branch.slice('refs/heads/'.length)
  if (new Set(parsedFiles.map(file => file.path)).size !== parsedFiles.length ||
    filePaths.reduce((total, path) => total + path.length, 0) > MAX_TOTAL_FILE_PATH_LENGTH ||
    !validEventChain(parsedEvents) || destination.head !== value.baseCommit || destination.clean !== true ||
    source.branch === undefined || destination.branch === undefined ||
    (source.kind === 'worktree' && source.branch !== worktreeBranch) ||
    (destination.kind === 'worktree' && destination.branch !== worktreeBranch) ||
    (value.direction === 'local-to-worktree' &&
      (source.kind !== 'local' || source.path !== value.repositoryRoot || destination.kind !== 'worktree' ||
        destination.path !== value.worktreePath)) ||
    (value.direction === 'worktree-to-local' &&
      (source.kind !== 'worktree' || source.path !== value.worktreePath || destination.kind !== 'local' ||
        destination.path !== value.repositoryRoot))) return undefined
  return {
    operationId: value.operationId,
    worktreeId: value.worktreeId,
    direction: value.direction,
    repositoryRoot: value.repositoryRoot,
    repositoryCommonDir: value.repositoryCommonDir,
    worktreePath: value.worktreePath,
    branch: value.branch,
    baseCommit: value.baseCommit,
    sourceTree: value.sourceTree,
    source,
    destination,
    files: parsedFiles,
    patchFingerprint: value.patchFingerprint,
    approvalFingerprint: value.approvalFingerprint,
    events: parsedEvents,
  }
}

function emptyDocument(): WorktreeHandoffJournalDocument {
  return { schemaVersion: WORKTREE_HANDOFF_JOURNAL_SCHEMA_VERSION, revision: 0, operations: [] }
}

function parseDocument(value: unknown): WorktreeHandoffJournalDocument {
  if (value === undefined) return emptyDocument()
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'operations']) ||
    value.schemaVersion !== WORKTREE_HANDOFF_JOURNAL_SCHEMA_VERSION || !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw new Error('The worktree handoff journal uses an unsupported or invalid document shape.')
  }
  const operations = value.operations.map(parseOperation)
  if (operations.some(operation => operation === undefined)) {
    throw new Error('The worktree handoff journal contains an invalid operation.')
  }
  const parsed = operations as WorktreeHandoffOperationRecord[]
  if (new Set(parsed.map(operation => operation.operationId)).size !== parsed.length) {
    throw new Error('The worktree handoff journal contains duplicate operation identifiers.')
  }
  return {
    schemaVersion: WORKTREE_HANDOFF_JOURNAL_SCHEMA_VERSION,
    revision: Number(value.revision),
    operations: parsed,
  }
}

function cloneOperation(operation: WorktreeHandoffOperationRecord): WorktreeHandoffOperationRecord {
  return {
    ...operation,
    source: { ...operation.source },
    destination: { ...operation.destination },
    files: operation.files.map(file => ({ ...file })),
    events: operation.events.map(event => ({ ...event })),
  }
}

function nextEventTime(now: () => Date, operation?: WorktreeHandoffOperationRecord): string {
  const current = now().getTime()
  const previous = operation === undefined ? 0 : Date.parse(operation.events.at(-1)!.at)
  return new Date(Math.max(current, previous)).toISOString()
}

function sameEndpoint(left: WorktreeHandoffEndpoint, right: WorktreeHandoffEndpoint): boolean {
  return left.kind === right.kind && left.path === right.path && left.branch === right.branch &&
    left.head === right.head && left.clean === right.clean
}

function sameFile(left: WorktreeHandoffFile, right: WorktreeHandoffFile): boolean {
  return left.status === right.status && left.path === right.path && left.originalPath === right.originalPath &&
    left.patchAvailable === right.patchAvailable
}

function matches(operation: WorktreeHandoffOperationRecord, input: BeginWorktreeHandoffOperationInput): boolean {
  return operation.worktreeId === input.worktreeId && operation.direction === input.direction &&
    operation.repositoryRoot === input.repositoryRoot &&
    operation.repositoryCommonDir === input.repositoryCommonDir && operation.worktreePath === input.worktreePath &&
    operation.branch === input.branch && operation.baseCommit === input.baseCommit &&
    operation.sourceTree === input.sourceTree && sameEndpoint(operation.source, input.source) &&
    sameEndpoint(operation.destination, input.destination) && operation.files.length === input.files.length &&
    operation.files.every((file, index) => sameFile(file, input.files[index]!)) &&
    operation.patchFingerprint === input.patchFingerprint &&
    operation.approvalFingerprint === input.approvalFingerprint
}

export function worktreeHandoffOperationPhase(
  operation: WorktreeHandoffOperationRecord,
): WorktreeHandoffOperationPhase {
  return operation.events.at(-1)!.phase
}

export class WorktreeHandoffJournal {
  private state = emptyDocument()
  private available = true
  private unavailableReason?: string
  private readonly now: () => Date
  private readonly maxOperations: number
  private readonly write: typeof writeJsonAtomically

  constructor(
    private readonly path: string,
    options: WorktreeHandoffJournalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.maxOperations = Math.max(1, Math.min(options.maxOperations ?? MAX_OPERATIONS, MAX_OPERATIONS))
    this.write = options.write ?? writeJsonAtomically
    try {
      this.state = parseDocument(readJsonFile(path))
      this.recoverInterrupted()
    } catch {
      this.available = false
      this.unavailableReason = 'The worktree handoff journal could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  get(operationId: string): WorktreeHandoffOperationRecord | undefined {
    this.assertAvailable()
    const operation = this.state.operations.find(candidate => candidate.operationId === operationId)
    return operation === undefined ? undefined : cloneOperation(operation)
  }

  begin(input: BeginWorktreeHandoffOperationInput): {
    operation: WorktreeHandoffOperationRecord
    created: boolean
  } {
    this.assertAvailable()
    const normalized = parseOperation({
      ...input,
      events: [{ phase: 'intent', at: nextEventTime(this.now) }],
    })
    if (normalized === undefined) {
      throw new WorktreeHandoffJournalError('BAD_MESSAGE', 'The worktree handoff intent is invalid.')
    }
    const existing = this.state.operations.find(operation => operation.operationId === input.operationId)
    if (existing !== undefined) {
      if (!matches(existing, input)) {
        throw new WorktreeHandoffJournalError(
          'DUPLICATE_REQUEST',
          'The worktree handoff identifier was already used for a different operation.',
        )
      }
      return { operation: cloneOperation(existing), created: false }
    }
    if (this.state.operations.length >= this.maxOperations) {
      throw new WorktreeHandoffJournalError('DESKTOP_UNAVAILABLE', 'The worktree handoff journal is full.')
    }
    this.commit(next => next.operations.push(normalized))
    return { operation: cloneOperation(normalized), created: true }
  }

  recordDispatch(operationId: string): WorktreeHandoffOperationRecord {
    return this.append(operationId, 'dispatch')
  }

  recordCancellation(operationId: string): WorktreeHandoffOperationRecord {
    return this.append(operationId, 'cancelled', 'cancelled-before-dispatch')
  }

  recordOutcome(
    operationId: string,
    phase: Extract<WorktreeHandoffOperationPhase, 'succeeded' | 'failed' | 'ambiguous'>,
    reason: WorktreeHandoffOperationReason,
  ): WorktreeHandoffOperationRecord {
    if (!isOutcome(phase, reason)) {
      throw new WorktreeHandoffJournalError('BAD_MESSAGE', 'The worktree handoff outcome is invalid.')
    }
    return this.append(operationId, phase, reason)
  }

  private recoverInterrupted(): void {
    if (!this.state.operations.some(operation => !isTerminal(worktreeHandoffOperationPhase(operation)))) return
    this.commit(next => {
      for (const operation of next.operations) {
        const phase = worktreeHandoffOperationPhase(operation)
        if (isTerminal(phase)) continue
        operation.events.push(phase === 'dispatch'
          ? {
              phase: 'ambiguous',
              reason: 'interrupted-after-dispatch',
              at: nextEventTime(this.now, operation),
            }
          : {
              phase: 'cancelled',
              reason: 'interrupted-before-dispatch',
              at: nextEventTime(this.now, operation),
            })
      }
    })
  }

  private append(
    operationId: string,
    phase: WorktreeHandoffOperationPhase,
    reason?: WorktreeHandoffOperationReason,
  ): WorktreeHandoffOperationRecord {
    this.assertAvailable()
    let result: WorktreeHandoffOperationRecord | undefined
    this.commit(next => {
      const operation = next.operations.find(candidate => candidate.operationId === operationId)
      if (operation === undefined) {
        throw new WorktreeHandoffJournalError('NOT_FOUND', 'The worktree handoff operation was not found.')
      }
      const current = worktreeHandoffOperationPhase(operation)
      if (!canTransition(current, phase) || !isOutcome(phase, reason) ||
        !transitionMatchesReason(current, phase, reason)) {
        throw new WorktreeHandoffJournalError(
          'DUPLICATE_REQUEST',
          'The worktree handoff operation phase is already complete.',
        )
      }
      operation.events.push({
        phase,
        at: nextEventTime(this.now, operation),
        ...(reason === undefined ? {} : { reason }),
      })
      result = cloneOperation(operation)
    })
    return result!
  }

  private commit(change: (next: WorktreeHandoffJournalDocument) => void): void {
    this.assertAvailable()
    if (this.state.revision === Number.MAX_SAFE_INTEGER) {
      this.available = false
      this.unavailableReason = 'The worktree handoff journal revision is exhausted.'
      throw new WorktreeHandoffJournalError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
    const next: WorktreeHandoffJournalDocument = {
      schemaVersion: WORKTREE_HANDOFF_JOURNAL_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      operations: this.state.operations.map(cloneOperation),
    }
    change(next)
    try {
      this.write(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof WorktreeHandoffJournalError) throw error
      this.available = false
      this.unavailableReason = 'The worktree handoff journal could not be persisted safely.'
      throw new WorktreeHandoffJournalError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new WorktreeHandoffJournalError(
        'DESKTOP_UNAVAILABLE',
        this.unavailableReason ?? 'The worktree handoff journal is unavailable.',
      )
    }
  }
}
