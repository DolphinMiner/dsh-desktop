import { isAbsolute, normalize } from 'node:path'

import type { GitIndexMutationKind } from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const GIT_MUTATION_JOURNAL_SCHEMA_VERSION = 3 as const
const MAX_OPERATIONS = 10_000
const MAX_PATH_LENGTH = 4_096
const MAX_PATHS = 256
const MAX_TOTAL_PATH_LENGTH = 65_536
const MAX_COMMIT_MESSAGE_LENGTH = 8_192

export type GitMutationPhase = 'intent' | 'dispatch' | 'succeeded' | 'failed' | 'cancelled' | 'ambiguous'
export type GitMutationKind = GitIndexMutationKind | 'revert' | 'commit'
export type GitMutationReason =
  | 'completed'
  | 'git-rejected'
  | 'result-ambiguous'
  | 'interrupted-before-dispatch'
  | 'interrupted-after-dispatch'

export interface GitMutationEvent {
  phase: GitMutationPhase
  at: string
  reason?: GitMutationReason
}

export interface GitMutationApproval {
  id: string
  fingerprint: string
}

export interface GitCommitMutation {
  message: string
  expectedHead?: string
  expectedTree: string
  stagedFingerprint: string
}

export interface GitMutationRecord {
  operationId: string
  sessionId: string
  workspaceRoot: string
  repositoryRoot: string
  repositoryCommonDir: string
  kind: GitMutationKind
  requestedPaths: string[]
  paths: string[]
  approval?: GitMutationApproval
  commit?: GitCommitMutation
  resultCommit?: string
  events: GitMutationEvent[]
}

export interface BeginGitMutationInput {
  operationId: string
  sessionId: string
  workspaceRoot: string
  repositoryRoot: string
  repositoryCommonDir: string
  kind: GitMutationKind
  requestedPaths: string[]
  paths: string[]
  approval?: GitMutationApproval
  commit?: GitCommitMutation
}

interface GitMutationJournalDocument {
  schemaVersion: typeof GIT_MUTATION_JOURNAL_SCHEMA_VERSION
  revision: number
  operations: GitMutationRecord[]
}

interface ParsedGitMutationJournalDocument {
  document: GitMutationJournalDocument
  migrated: boolean
}

export interface GitMutationJournalOptions {
  now?: () => Date
  maxOperations?: number
  write?: typeof writeJsonAtomically
}

export class GitMutationJournalError extends Error {
  constructor(
    readonly code: 'BAD_MESSAGE' | 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'GitMutationJournalError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isBoundedString(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isUuid(value: unknown): value is string {
  return isBoundedString(value, 36) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return isBoundedString(value, MAX_PATH_LENGTH) && isAbsolute(value) && normalize(value) === value
}

function isKind(value: unknown): value is GitMutationKind {
  return value === 'stage' || value === 'unstage' || value === 'revert' || value === 'commit'
}

function parseApproval(value: unknown): GitMutationApproval | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'fingerprint']) || !isUuid(value.id) ||
    typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return undefined
  return { id: value.id, fingerprint: value.fingerprint }
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function parseCommit(value: unknown): GitCommitMutation | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'message', 'expectedHead', 'expectedTree', 'stagedFingerprint',
  ]) || typeof value.message !== 'string' || value.message.length > MAX_COMMIT_MESSAGE_LENGTH ||
    value.message.trim().length === 0 || value.message.includes('\0') ||
    (value.expectedHead !== undefined && !isObjectId(value.expectedHead)) || !isObjectId(value.expectedTree) ||
    typeof value.stagedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.stagedFingerprint)) {
    return undefined
  }
  return {
    message: value.message,
    ...(value.expectedHead === undefined ? {} : { expectedHead: value.expectedHead }),
    expectedTree: value.expectedTree,
    stagedFingerprint: value.stagedFingerprint,
  }
}

function isPhase(value: unknown): value is GitMutationPhase {
  return value === 'intent' || value === 'dispatch' || value === 'succeeded' || value === 'failed' ||
    value === 'cancelled' || value === 'ambiguous'
}

function isReason(value: unknown): value is GitMutationReason {
  return value === 'completed' || value === 'git-rejected' || value === 'result-ambiguous' ||
    value === 'interrupted-before-dispatch' || value === 'interrupted-after-dispatch'
}

function isTerminal(phase: GitMutationPhase): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled' || phase === 'ambiguous'
}

function canTransition(from: GitMutationPhase, to: GitMutationPhase): boolean {
  if (from === 'intent') return to === 'dispatch' || to === 'cancelled'
  if (from === 'dispatch') return to === 'succeeded' || to === 'failed' || to === 'ambiguous'
  return false
}

function isOutcome(phase: GitMutationPhase, reason: GitMutationReason | undefined): boolean {
  if (phase === 'succeeded') return reason === 'completed'
  if (phase === 'failed') return reason === 'git-rejected'
  if (phase === 'cancelled') return reason === 'interrupted-before-dispatch'
  if (phase === 'ambiguous') {
    return reason === 'result-ambiguous' || reason === 'interrupted-after-dispatch'
  }
  return reason === undefined
}

function parseEvent(value: unknown): GitMutationEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['phase', 'at', 'reason']) || !isPhase(value.phase) ||
    !isIsoDate(value.at) || (value.reason !== undefined && !isReason(value.reason)) ||
    !isOutcome(value.phase, value.reason as GitMutationReason | undefined)) return undefined
  return {
    phase: value.phase,
    at: value.at,
    ...(value.reason === undefined ? {} : { reason: value.reason as GitMutationReason }),
  }
}

function parsePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATHS ||
    value.some(path => !isBoundedString(path, MAX_PATH_LENGTH)) || new Set(value).size !== value.length ||
    value.reduce((total, path) => total + (path as string).length, 0) > MAX_TOTAL_PATH_LENGTH) {
    return undefined
  }
  return [...value] as string[]
}

function parseRecord(value: unknown): GitMutationRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'operationId', 'sessionId', 'workspaceRoot', 'repositoryRoot', 'repositoryCommonDir', 'kind', 'requestedPaths',
    'paths', 'approval', 'commit', 'resultCommit', 'events',
  ]) || !isUuid(value.operationId) || !isBoundedString(value.sessionId) ||
    !isBoundedString(value.workspaceRoot, MAX_PATH_LENGTH) || !isCanonicalAbsolutePath(value.repositoryRoot) ||
    !isCanonicalAbsolutePath(value.repositoryCommonDir) || !isKind(value.kind) ||
    !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 8) return undefined
  const requestedPaths = parsePaths(value.requestedPaths)
  const paths = parsePaths(value.paths)
  const approval = value.approval === undefined ? undefined : parseApproval(value.approval)
  const commit = value.commit === undefined ? undefined : parseCommit(value.commit)
  const events = value.events.map(parseEvent)
  if (requestedPaths === undefined || paths === undefined || events.some(event => event === undefined) ||
    (value.kind === 'revert' ? approval === undefined || approval.id !== value.operationId : approval !== undefined) ||
    (value.kind === 'commit' ? commit === undefined : commit !== undefined) ||
    (value.resultCommit !== undefined && !isObjectId(value.resultCommit))) {
    return undefined
  }
  const parsedEvents = events as GitMutationEvent[]
  if (parsedEvents[0]?.phase !== 'intent') return undefined
  for (let index = 1; index < parsedEvents.length; index += 1) {
    if (!canTransition(parsedEvents[index - 1]!.phase, parsedEvents[index]!.phase) ||
      Date.parse(parsedEvents[index]!.at) < Date.parse(parsedEvents[index - 1]!.at)) return undefined
  }
  const terminalPhase = parsedEvents.at(-1)!.phase
  if (value.kind === 'commit') {
    if ((terminalPhase === 'succeeded') !== (value.resultCommit !== undefined)) return undefined
  } else if (value.resultCommit !== undefined) return undefined
  return {
    operationId: value.operationId,
    sessionId: value.sessionId,
    workspaceRoot: value.workspaceRoot,
    repositoryRoot: value.repositoryRoot,
    repositoryCommonDir: value.repositoryCommonDir,
    kind: value.kind,
    requestedPaths,
    paths,
    ...(approval === undefined ? {} : { approval }),
    ...(commit === undefined ? {} : { commit }),
    ...(value.resultCommit === undefined ? {} : { resultCommit: value.resultCommit }),
    events: parsedEvents,
  }
}

function emptyDocument(): GitMutationJournalDocument {
  return { schemaVersion: GIT_MUTATION_JOURNAL_SCHEMA_VERSION, revision: 0, operations: [] }
}

function parseDocument(value: unknown): ParsedGitMutationJournalDocument {
  if (value === undefined) return { document: emptyDocument(), migrated: false }
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'operations']) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 &&
      value.schemaVersion !== GIT_MUTATION_JOURNAL_SCHEMA_VERSION) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) {
    throw new Error('The Git mutation journal uses an unsupported or invalid document shape.')
  }
  const operations = value.operations.map(parseRecord)
  if (operations.some(operation => operation === undefined)) {
    throw new Error('The Git mutation journal contains an invalid operation.')
  }
  const parsed = operations as GitMutationRecord[]
  if (new Set(parsed.map(operation => operation.operationId)).size !== parsed.length) {
    throw new Error('The Git mutation journal contains duplicate operation identifiers.')
  }
  if (value.schemaVersion === 1 && parsed.some(operation => operation.kind === 'revert' ||
    operation.kind === 'commit' || operation.approval !== undefined || operation.commit !== undefined ||
    operation.resultCommit !== undefined)) {
    throw new Error('The legacy Git mutation journal contains unsupported operation data.')
  }
  if (value.schemaVersion === 2 && parsed.some(operation => operation.kind === 'commit' ||
    operation.commit !== undefined || operation.resultCommit !== undefined)) {
    throw new Error('The v2 Git mutation journal contains unsupported operation data.')
  }
  const migrated = value.schemaVersion !== GIT_MUTATION_JOURNAL_SCHEMA_VERSION
  if (migrated && Number(value.revision) === Number.MAX_SAFE_INTEGER) {
    throw new Error('The legacy Git mutation journal revision cannot be migrated safely.')
  }
  return {
    migrated,
    document: {
      schemaVersion: GIT_MUTATION_JOURNAL_SCHEMA_VERSION,
      revision: Number(value.revision) + (migrated ? 1 : 0),
      operations: parsed,
    },
  }
}

function cloneRecord(record: GitMutationRecord): GitMutationRecord {
  return {
    ...record,
    requestedPaths: [...record.requestedPaths],
    paths: [...record.paths],
    ...(record.approval === undefined ? {} : { approval: { ...record.approval } }),
    ...(record.commit === undefined ? {} : { commit: { ...record.commit } }),
    ...(record.resultCommit === undefined ? {} : { resultCommit: record.resultCommit }),
    events: record.events.map(event => ({ ...event })),
  }
}

function nextEventTime(now: () => Date, operation?: GitMutationRecord): string {
  const current = now().getTime()
  const previous = operation === undefined ? 0 : Date.parse(operation.events.at(-1)!.at)
  return new Date(Math.max(current, previous)).toISOString()
}

function matches(record: GitMutationRecord, input: BeginGitMutationInput): boolean {
  return record.sessionId === input.sessionId && record.workspaceRoot === input.workspaceRoot &&
    record.repositoryRoot === input.repositoryRoot && record.repositoryCommonDir === input.repositoryCommonDir &&
    record.kind === input.kind && record.requestedPaths.length === input.requestedPaths.length &&
    record.requestedPaths.every((path, index) => path === input.requestedPaths[index]) &&
    record.paths.length === input.paths.length &&
    record.paths.every((path, index) => path === input.paths[index]) &&
    (record.approval === undefined) === (input.approval === undefined) &&
    (record.approval === undefined || (record.approval.id === input.approval?.id &&
      record.approval.fingerprint === input.approval.fingerprint)) &&
    (record.commit === undefined) === (input.commit === undefined) &&
    (record.commit === undefined || (record.commit.message === input.commit?.message &&
      record.commit.expectedHead === input.commit.expectedHead &&
      record.commit.expectedTree === input.commit.expectedTree &&
      record.commit.stagedFingerprint === input.commit.stagedFingerprint))
}

export function gitMutationPhase(record: GitMutationRecord): GitMutationPhase {
  return record.events.at(-1)!.phase
}

export class GitMutationJournal {
  private state = emptyDocument()
  private available = true
  private unavailableReason?: string
  private readonly now: () => Date
  private readonly maxOperations: number
  private readonly write: typeof writeJsonAtomically

  constructor(
    private readonly path: string,
    options: GitMutationJournalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.maxOperations = Math.max(1, Math.min(options.maxOperations ?? MAX_OPERATIONS, MAX_OPERATIONS))
    this.write = options.write ?? writeJsonAtomically
    try {
      const loaded = parseDocument(readJsonFile(path))
      this.state = loaded.document
      if (loaded.migrated) this.write(this.path, this.state)
      this.recoverInterrupted()
    } catch {
      this.available = false
      this.unavailableReason = 'The Git mutation journal could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  get(operationId: string): GitMutationRecord | undefined {
    this.assertAvailable()
    const record = this.state.operations.find(operation => operation.operationId === operationId)
    return record === undefined ? undefined : cloneRecord(record)
  }

  recent(limit = 20): GitMutationRecord[] {
    this.assertAvailable()
    const bounded = Math.max(0, Math.min(limit, 100))
    return this.state.operations.slice(-bounded).reverse().map(cloneRecord)
  }

  begin(input: BeginGitMutationInput): { record: GitMutationRecord; created: boolean } {
    this.assertAvailable()
    const normalized = parseRecord({ ...input, events: [{ phase: 'intent', at: nextEventTime(this.now) }] })
    if (normalized === undefined) {
      throw new GitMutationJournalError('BAD_MESSAGE', 'The Git mutation intent is invalid.')
    }
    const existing = this.state.operations.find(operation => operation.operationId === input.operationId)
    if (existing !== undefined) {
      if (!matches(existing, input)) {
        throw new GitMutationJournalError(
          'DUPLICATE_REQUEST',
          'The Git mutation identifier was already used for a different operation.',
        )
      }
      return { record: cloneRecord(existing), created: false }
    }
    if (this.state.operations.length >= this.maxOperations) {
      throw new GitMutationJournalError('DESKTOP_UNAVAILABLE', 'The Git mutation journal is full.')
    }
    this.commit(next => next.operations.push(normalized))
    return { record: cloneRecord(normalized), created: true }
  }

  recordDispatch(operationId: string): GitMutationRecord {
    return this.append(operationId, 'dispatch')
  }

  recordOutcome(
    operationId: string,
    phase: Extract<GitMutationPhase, 'succeeded' | 'failed' | 'ambiguous'>,
    reason: GitMutationReason,
    resultCommit?: string,
  ): GitMutationRecord {
    if (!isOutcome(phase, reason)) {
      throw new GitMutationJournalError('BAD_MESSAGE', 'The Git mutation outcome is invalid.')
    }
    return this.append(operationId, phase, reason, resultCommit)
  }

  private recoverInterrupted(): void {
    if (!this.state.operations.some(operation => !isTerminal(gitMutationPhase(operation)))) return
    this.commit(next => {
      for (const operation of next.operations) {
        const phase = gitMutationPhase(operation)
        if (isTerminal(phase)) continue
        const at = nextEventTime(this.now, operation)
        operation.events.push(phase === 'dispatch'
          ? { phase: 'ambiguous', reason: 'interrupted-after-dispatch', at }
          : { phase: 'cancelled', reason: 'interrupted-before-dispatch', at })
      }
    })
  }

  private append(
    operationId: string,
    phase: GitMutationPhase,
    reason?: GitMutationReason,
    resultCommit?: string,
  ): GitMutationRecord {
    this.assertAvailable()
    let result: GitMutationRecord | undefined
    this.commit(next => {
      const operation = next.operations.find(item => item.operationId === operationId)
      if (operation === undefined) throw new GitMutationJournalError('NOT_FOUND', 'The Git mutation was not found.')
      const current = gitMutationPhase(operation)
      if (!canTransition(current, phase) || !isOutcome(phase, reason)) {
        throw new GitMutationJournalError('DUPLICATE_REQUEST', 'The Git mutation phase is already complete.')
      }
      if (operation.kind === 'commit') {
        if ((phase === 'succeeded') !== isObjectId(resultCommit)) {
          throw new GitMutationJournalError('BAD_MESSAGE', 'The Git commit outcome is invalid.')
        }
      } else if (resultCommit !== undefined) {
        throw new GitMutationJournalError('BAD_MESSAGE', 'This Git mutation cannot record a commit result.')
      }
      operation.events.push({
        phase,
        at: nextEventTime(this.now, operation),
        ...(reason === undefined ? {} : { reason }),
      })
      if (resultCommit !== undefined) operation.resultCommit = resultCommit
      result = cloneRecord(operation)
    })
    return result!
  }

  private commit(change: (next: GitMutationJournalDocument) => void): void {
    this.assertAvailable()
    const next: GitMutationJournalDocument = {
      schemaVersion: GIT_MUTATION_JOURNAL_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      operations: this.state.operations.map(cloneRecord),
    }
    change(next)
    try {
      this.write(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof GitMutationJournalError) throw error
      this.available = false
      this.unavailableReason = 'The Git mutation journal could not be persisted safely.'
      throw new GitMutationJournalError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new GitMutationJournalError(
        'DESKTOP_UNAVAILABLE',
        this.unavailableReason ?? 'The Git mutation journal is unavailable.',
      )
    }
  }
}
