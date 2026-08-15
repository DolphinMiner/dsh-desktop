import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import type {
  GitRepositoryIdentity,
  WorktreeExecutionMode,
  WorktreeLifecycle,
  WorktreeRecoveryReason,
  WorktreeSummary,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const WORKTREE_REGISTRY_SCHEMA_VERSION = 1 as const
const MISSING_RESOLUTION_OPERATION_PREFIX = 'forget-missing:'
const MAX_RECORDS = 10_000
const MAX_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024

export type WorktreeOperationKind = 'create' | 'remove'

export interface WorktreePendingOperation {
  id: string
  kind: WorktreeOperationKind
}

export interface WorktreeRecord {
  id: string
  repository: GitRepositoryIdentity
  requestedBySessionId: string
  sessionId?: string
  executionMode: WorktreeExecutionMode
  worktreePath?: string
  baseRef: string
  baseCommit: string
  branch?: string
  lifecycle: WorktreeLifecycle
  creationOperationId: string
  pendingOperation?: WorktreePendingOperation
  removalOperationId?: string
  recoveryReason?: WorktreeRecoveryReason
  createdAt: string
  updatedAt: string
}

export interface WorktreeReservation {
  operationId: string
  repository: GitRepositoryIdentity
  requestedBySessionId: string
  executionMode: WorktreeExecutionMode
  worktreePath?: string
  baseRef: string
  baseCommit: string
  branch?: string
}

interface WorktreeRegistryDocument {
  schemaVersion: typeof WORKTREE_REGISTRY_SCHEMA_VERSION
  revision: number
  records: WorktreeRecord[]
}

export interface WorktreeRegistryOptions {
  now?: () => Date
  maxRecords?: number
}

export interface WorktreeRecoveryRequirement {
  id: string
  reason: WorktreeRecoveryReason
}

export interface WorktreeRecoveryResolution {
  id: string
  lifecycle: 'ready' | 'orphaned'
}

export class WorktreeRegistryError extends Error {
  constructor(
    readonly code: 'BAD_MESSAGE' | 'CONFLICT' | 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'WorktreeRegistryError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isBoundedString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isUuid(value: unknown): value is string {
  return isBoundedString(value, 36) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return isBoundedString(value, MAX_PATH_LENGTH) && isAbsolute(value) && normalize(value) === value
}

function isBaseRef(value: unknown): value is string {
  return isBoundedString(value, MAX_REF_LENGTH) && !/[\r\n]/.test(value)
}

function isLifecycle(value: unknown): value is WorktreeLifecycle {
  return value === 'provisioning' || value === 'ready' || value === 'removing' ||
    value === 'recovery-required' || value === 'orphaned' || value === 'removed'
}

function isRecoveryReason(value: unknown): value is WorktreeRecoveryReason {
  return value === 'create-ambiguous' || value === 'interrupted-create' || value === 'interrupted-remove' ||
    value === 'inspection-failed' || value === 'external-change' || value === 'locked' ||
    value === 'missing' || value === 'moved'
}

function parseRepository(value: unknown): GitRepositoryIdentity | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['root', 'gitDir', 'commonDir']) ||
    !isCanonicalAbsolutePath(value.root) || !isCanonicalAbsolutePath(value.gitDir) ||
    !isCanonicalAbsolutePath(value.commonDir)) return undefined
  return { root: value.root, gitDir: value.gitDir, commonDir: value.commonDir }
}

function parsePendingOperation(value: unknown): WorktreePendingOperation | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'kind']) || !isBoundedString(value.id) ||
    (value.kind !== 'create' && value.kind !== 'remove')) return undefined
  return { id: value.id, kind: value.kind }
}

function parseStoredRecord(value: unknown): WorktreeRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'repository', 'requestedBySessionId', 'sessionId', 'executionMode', 'worktreePath', 'baseRef', 'baseCommit',
    'branch', 'lifecycle', 'creationOperationId', 'pendingOperation', 'removalOperationId',
    'recoveryReason', 'createdAt', 'updatedAt',
  ]) || !isUuid(value.id) || !isBoundedString(value.requestedBySessionId) ||
    (value.sessionId !== undefined && !isBoundedString(value.sessionId)) ||
    (value.executionMode !== 'local' && value.executionMode !== 'worktree') ||
    !isBaseRef(value.baseRef) || !isCommit(value.baseCommit) || !isLifecycle(value.lifecycle) ||
    !isBoundedString(value.creationOperationId) || !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)) return undefined
  const repository = parseRepository(value.repository)
  if (repository === undefined ||
    (value.branch !== undefined && !isBaseRef(value.branch)) ||
    (value.removalOperationId !== undefined && !isBoundedString(value.removalOperationId)) ||
    (value.recoveryReason !== undefined && !isRecoveryReason(value.recoveryReason))) return undefined
  const pendingOperation = value.pendingOperation === undefined
    ? undefined
    : parsePendingOperation(value.pendingOperation)
  if (value.pendingOperation !== undefined && pendingOperation === undefined) return undefined
  if (value.executionMode === 'worktree') {
    if (!isCanonicalAbsolutePath(value.worktreePath) || value.worktreePath === repository.root) return undefined
  } else if (value.worktreePath !== undefined) {
    return undefined
  }
  if (value.lifecycle === 'provisioning' && pendingOperation?.kind !== 'create') return undefined
  if (value.lifecycle === 'removing' && pendingOperation?.kind !== 'remove') return undefined
  if (pendingOperation?.kind === 'create' && pendingOperation.id !== value.creationOperationId) return undefined
  if (pendingOperation?.kind === 'remove' && pendingOperation.id === value.creationOperationId) return undefined
  if (value.lifecycle === 'recovery-required') {
    if (!isRecoveryReason(value.recoveryReason)) return undefined
  } else if (value.recoveryReason !== undefined) {
    return undefined
  }
  if ((value.lifecycle === 'ready' || value.lifecycle === 'orphaned' || value.lifecycle === 'removed') &&
    pendingOperation !== undefined) return undefined
  if (value.lifecycle === 'removed' && value.removalOperationId === undefined) return undefined
  if (value.lifecycle !== 'removed' && value.removalOperationId !== undefined) return undefined
  if (value.removalOperationId === value.creationOperationId ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return undefined
  return {
    id: value.id,
    repository,
    requestedBySessionId: value.requestedBySessionId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    executionMode: value.executionMode,
    ...(value.worktreePath === undefined ? {} : { worktreePath: value.worktreePath }),
    baseRef: value.baseRef,
    baseCommit: value.baseCommit,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    lifecycle: value.lifecycle,
    creationOperationId: value.creationOperationId,
    ...(pendingOperation === undefined ? {} : { pendingOperation }),
    ...(value.removalOperationId === undefined ? {} : { removalOperationId: value.removalOperationId }),
    ...(value.recoveryReason === undefined ? {} : { recoveryReason: value.recoveryReason }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function cloneRecord(record: WorktreeRecord): WorktreeRecord {
  return {
    ...record,
    repository: { ...record.repository },
    ...(record.pendingOperation === undefined ? {} : { pendingOperation: { ...record.pendingOperation } }),
  }
}

function monotonicUpdatedAt(now: Date, record: Pick<WorktreeRecord, 'createdAt' | 'updatedAt'>): string {
  return new Date(Math.max(now.getTime(), Date.parse(record.createdAt), Date.parse(record.updatedAt))).toISOString()
}

export function summarizeWorktreeRecord(record: WorktreeRecord): WorktreeSummary {
  return {
    id: record.id,
    repositoryRoot: record.repository.root,
    requestedBySessionId: record.requestedBySessionId,
    sessionState: record.sessionId === undefined ? 'pending' : 'bound',
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    executionMode: record.executionMode,
    ...(record.worktreePath === undefined ? {} : { worktreePath: record.worktreePath }),
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    ...(record.branch === undefined ? {} : { branch: record.branch }),
    lifecycle: record.lifecycle,
    ...(record.recoveryReason === undefined ? {} : { recoveryReason: record.recoveryReason }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function emptyDocument(): WorktreeRegistryDocument {
  return { schemaVersion: WORKTREE_REGISTRY_SCHEMA_VERSION, revision: 0, records: [] }
}

function effectiveCheckoutPath(record: Pick<WorktreeRecord, 'executionMode' | 'repository' | 'worktreePath'>): string {
  return record.executionMode === 'local' ? record.repository.root : record.worktreePath!
}

function isActive(record: WorktreeRecord): boolean {
  return record.lifecycle !== 'removed'
}

function operationIds(record: WorktreeRecord): string[] {
  return [
    record.creationOperationId,
    ...(record.pendingOperation?.kind === 'remove' ? [record.pendingOperation.id] : []),
    ...(record.removalOperationId === undefined ? [] : [record.removalOperationId]),
  ]
}

function parseDocument(value: unknown): WorktreeRegistryDocument {
  if (value === undefined) return emptyDocument()
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'records']) ||
    value.schemaVersion !== WORKTREE_REGISTRY_SCHEMA_VERSION || !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    throw new Error('The worktree registry uses an unsupported or invalid document shape.')
  }
  const parsed = value.records.map(parseStoredRecord)
  if (parsed.some(record => record === undefined)) {
    throw new Error('The worktree registry contains an invalid record.')
  }
  const records = parsed as WorktreeRecord[]
  const allOperationIds = records.flatMap(operationIds)
  if (new Set(records.map(record => record.id)).size !== records.length ||
    new Set(allOperationIds).size !== allOperationIds.length) {
    throw new Error('The worktree registry contains duplicate immutable identifiers.')
  }
  const active = records.filter(isActive)
  const boundSessionIds = active.flatMap(record => record.sessionId === undefined ? [] : [record.sessionId])
  if (new Set(active.map(record => record.requestedBySessionId)).size !== active.length ||
    new Set(boundSessionIds).size !== boundSessionIds.length ||
    new Set(active.map(effectiveCheckoutPath)).size !== active.length) {
    throw new Error('The worktree registry contains conflicting active assignments.')
  }
  return {
    schemaVersion: WORKTREE_REGISTRY_SCHEMA_VERSION,
    revision: Number(value.revision),
    records,
  }
}

function normalizeReservation(value: WorktreeReservation): WorktreeReservation {
  const repository = parseRepository(value.repository)
  if (!isBoundedString(value.operationId) || repository === undefined ||
    !isBoundedString(value.requestedBySessionId) ||
    (value.executionMode !== 'local' && value.executionMode !== 'worktree') ||
    !isBaseRef(value.baseRef) || !isCommit(value.baseCommit) ||
    (value.branch !== undefined && !isBaseRef(value.branch))) {
    throw new WorktreeRegistryError('BAD_MESSAGE', 'The worktree reservation is invalid.')
  }
  if (value.executionMode === 'worktree') {
    if (!isCanonicalAbsolutePath(value.worktreePath) || value.worktreePath === repository.root) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The isolated worktree path is invalid.')
    }
  } else if (value.worktreePath !== undefined) {
    throw new WorktreeRegistryError('BAD_MESSAGE', 'Local execution cannot declare an isolated worktree path.')
  }
  return {
    operationId: value.operationId,
    repository,
    requestedBySessionId: value.requestedBySessionId,
    executionMode: value.executionMode,
    ...(value.worktreePath === undefined ? {} : { worktreePath: value.worktreePath }),
    baseRef: value.baseRef,
    baseCommit: value.baseCommit,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
  }
}

function matchesReservation(record: WorktreeRecord, input: WorktreeReservation): boolean {
  return record.requestedBySessionId === input.requestedBySessionId &&
    record.executionMode === input.executionMode &&
    record.worktreePath === input.worktreePath && record.baseRef === input.baseRef &&
    record.baseCommit === input.baseCommit && record.branch === input.branch &&
    record.repository.root === input.repository.root && record.repository.gitDir === input.repository.gitDir &&
    record.repository.commonDir === input.repository.commonDir
}

export class WorktreeRegistry {
  private state: WorktreeRegistryDocument = emptyDocument()
  private available = true
  private unavailableReason?: string
  private readonly now: () => Date
  private readonly maxRecords: number

  constructor(
    private readonly path: string,
    options: WorktreeRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.maxRecords = Math.max(1, Math.min(options.maxRecords ?? MAX_RECORDS, MAX_RECORDS))
    try {
      this.state = parseDocument(readJsonFile(path))
      this.recoverInterruptedOperations()
    } catch {
      this.available = false
      this.unavailableReason = 'The worktree registry could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  list(): WorktreeRecord[] {
    this.assertAvailable()
    return this.state.records.map(cloneRecord)
  }

  get(id: string): WorktreeRecord | undefined {
    this.assertAvailable()
    const record = this.state.records.find(item => item.id === id)
    return record === undefined ? undefined : cloneRecord(record)
  }

  getByCreationOperation(operationId: string): WorktreeRecord | undefined {
    this.assertAvailable()
    const record = this.state.records.find(item => item.creationOperationId === operationId)
    return record === undefined ? undefined : cloneRecord(record)
  }

  getByOperation(operationId: string): WorktreeRecord | undefined {
    this.assertAvailable()
    const record = this.state.records.find(item => operationIds(item).includes(operationId))
    return record === undefined ? undefined : cloneRecord(record)
  }

  getByCheckoutPath(path: string): WorktreeRecord | undefined {
    this.assertAvailable()
    const record = this.state.records.find(item => isActive(item) && effectiveCheckoutPath(item) === path)
    return record === undefined ? undefined : cloneRecord(record)
  }

  reserve(value: WorktreeReservation): WorktreeRecord {
    this.assertAvailable()
    const input = normalizeReservation(value)
    const existing = this.state.records.find(record => record.creationOperationId === input.operationId)
    if (existing !== undefined) {
      if (!matchesReservation(existing, input)) {
        throw new WorktreeRegistryError(
          'DUPLICATE_REQUEST',
          'The worktree operation identifier was already used for a different reservation.',
        )
      }
      return cloneRecord(existing)
    }
    if (this.state.records.some(record => operationIds(record).includes(input.operationId))) {
      throw new WorktreeRegistryError(
        'DUPLICATE_REQUEST',
        'The worktree operation identifier has already been used.',
      )
    }
    if (this.state.records.length >= this.maxRecords) {
      throw new WorktreeRegistryError('DESKTOP_UNAVAILABLE', 'The worktree registry is full.')
    }
    const checkoutPath = input.executionMode === 'local' ? input.repository.root : input.worktreePath!
    if (this.state.records.some(record =>
      isActive(record) && record.requestedBySessionId === input.requestedBySessionId)) {
      throw new WorktreeRegistryError('CONFLICT', 'This session already requested an active checkout assignment.')
    }
    if (this.state.records.some(record => isActive(record) && effectiveCheckoutPath(record) === checkoutPath)) {
      throw new WorktreeRegistryError('CONFLICT', 'This checkout is already assigned to another active session.')
    }
    const now = this.now().toISOString()
    const record: WorktreeRecord = {
      id: randomUUID(),
      repository: { ...input.repository },
      requestedBySessionId: input.requestedBySessionId,
      executionMode: input.executionMode,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      baseRef: input.baseRef,
      baseCommit: input.baseCommit,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      lifecycle: 'provisioning',
      creationOperationId: input.operationId,
      pendingOperation: { id: input.operationId, kind: 'create' },
      createdAt: now,
      updatedAt: now,
    }
    this.commit(next => next.records.push(record))
    return cloneRecord(record)
  }

  bindSession(id: string, sessionId: string): WorktreeRecord {
    if (!isBoundedString(sessionId)) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The worktree session identifier is invalid.')
    }
    const owner = this.state.records.find(record => isActive(record) && record.sessionId === sessionId)
    if (owner !== undefined && owner.id !== id) {
      throw new WorktreeRegistryError('CONFLICT', 'This Harness session is already assigned to another checkout.')
    }
    return this.transition(id, record => {
      if (record.lifecycle !== 'ready') {
        throw new WorktreeRegistryError('CONFLICT', 'The worktree is not ready for a Harness session.')
      }
      if (record.sessionId === sessionId) return false
      if (record.sessionId !== undefined) {
        throw new WorktreeRegistryError('CONFLICT', 'This checkout is already assigned to another Harness session.')
      }
      record.sessionId = sessionId
      return true
    })
  }

  markReady(id: string, operationId: string): WorktreeRecord {
    return this.transition(id, record => {
      if (record.lifecycle === 'ready' && record.creationOperationId === operationId) return false
      if ((record.lifecycle !== 'provisioning' && record.lifecycle !== 'recovery-required') ||
        record.pendingOperation?.kind !== 'create' || record.pendingOperation.id !== operationId) {
        throw new WorktreeRegistryError('CONFLICT', 'The worktree create operation is not active.')
      }
      record.lifecycle = 'ready'
      delete record.pendingOperation
      delete record.recoveryReason
      return true
    })
  }

  beginRemoval(id: string, operationId: string): WorktreeRecord {
    if (!isBoundedString(operationId)) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The worktree remove operation identifier is invalid.')
    }
    const operationOwner = this.state.records.find(record => operationIds(record).includes(operationId))
    if (operationOwner !== undefined) {
      const sameRemoval = operationOwner.id === id &&
        (operationOwner.removalOperationId === operationId ||
          (operationOwner.pendingOperation?.kind === 'remove' && operationOwner.pendingOperation.id === operationId))
      if (!sameRemoval) {
        throw new WorktreeRegistryError(
          'DUPLICATE_REQUEST',
          'The worktree operation identifier has already been used.',
        )
      }
    }
    return this.transition(id, record => {
      if (record.lifecycle === 'removed' && record.removalOperationId === operationId) return false
      if ((record.lifecycle === 'removing' || record.lifecycle === 'recovery-required') &&
        record.pendingOperation?.kind === 'remove' && record.pendingOperation.id === operationId) return false
      if (record.lifecycle !== 'ready' && record.lifecycle !== 'orphaned' &&
        !(record.lifecycle === 'recovery-required' && record.pendingOperation === undefined)) {
        throw new WorktreeRegistryError('CONFLICT', 'The worktree is not ready to begin removal.')
      }
      record.lifecycle = 'removing'
      record.pendingOperation = { id: operationId, kind: 'remove' }
      delete record.recoveryReason
      return true
    })
  }

  markRemoved(id: string, operationId: string): WorktreeRecord {
    return this.transition(id, record => {
      if (record.lifecycle === 'removed' && record.removalOperationId === operationId) return false
      if ((record.lifecycle !== 'removing' && record.lifecycle !== 'recovery-required') ||
        record.pendingOperation?.kind !== 'remove' || record.pendingOperation.id !== operationId) {
        throw new WorktreeRegistryError('CONFLICT', 'The worktree remove operation is not active.')
      }
      record.lifecycle = 'removed'
      record.removalOperationId = operationId
      delete record.pendingOperation
      delete record.recoveryReason
      return true
    })
  }

  keepInterruptedRemoval(id: string, removalOperationId: string): WorktreeRecord {
    if (!isBoundedString(removalOperationId)) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The interrupted remove operation identifier is invalid.')
    }
    return this.transition(id, record => {
      if (record.lifecycle !== 'recovery-required' || record.recoveryReason !== 'interrupted-remove' ||
        record.pendingOperation?.kind !== 'remove' || record.pendingOperation.id !== removalOperationId) {
        throw new WorktreeRegistryError(
          'CONFLICT',
          'The worktree no longer has the reviewed interrupted removal.',
        )
      }
      record.lifecycle = record.sessionId === undefined ? 'orphaned' : 'ready'
      delete record.pendingOperation
      delete record.recoveryReason
      return true
    })
  }

  forgetMissingWorktree(id: string, resolutionOperationId: string): WorktreeRecord {
    const storedOperationId = `${MISSING_RESOLUTION_OPERATION_PREFIX}${resolutionOperationId}`
    if (!isBoundedString(resolutionOperationId) || !isBoundedString(storedOperationId)) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The missing-worktree resolution identifier is invalid.')
    }
    this.assertAvailable()
    const operationOwner = this.state.records.find(record => operationIds(record).includes(storedOperationId))
    if (operationOwner !== undefined) {
      const sameResolution = operationOwner.id === id && operationOwner.lifecycle === 'removed' &&
        operationOwner.removalOperationId === storedOperationId
      if (!sameResolution) {
        throw new WorktreeRegistryError(
          'DUPLICATE_REQUEST',
          'The worktree operation identifier has already been used.',
        )
      }
    }
    return this.transition(id, record => {
      if (record.lifecycle === 'removed' && record.removalOperationId === storedOperationId) return false
      if (record.executionMode !== 'worktree' || record.lifecycle !== 'recovery-required' ||
        record.recoveryReason !== 'missing' || record.pendingOperation !== undefined) {
        throw new WorktreeRegistryError(
          'CONFLICT',
          'The worktree no longer has the reviewed missing-checkout state.',
        )
      }
      record.lifecycle = 'removed'
      record.removalOperationId = storedOperationId
      delete record.recoveryReason
      return true
    })
  }

  requireRecovery(id: string, reason: WorktreeRecoveryReason): WorktreeRecord {
    if (!isRecoveryReason(reason)) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The worktree recovery reason is invalid.')
    }
    return this.transition(id, record => {
      if (record.lifecycle === 'removed') {
        throw new WorktreeRegistryError('CONFLICT', 'A removed worktree cannot require recovery.')
      }
      if (record.lifecycle === 'recovery-required' && record.recoveryReason === reason) return false
      record.lifecycle = 'recovery-required'
      record.recoveryReason = reason
      return true
    })
  }

  requireRecoveryBatch(requirements: readonly WorktreeRecoveryRequirement[]): WorktreeRecord[] {
    this.assertAvailable()
    if (new Set(requirements.map(requirement => requirement.id)).size !== requirements.length ||
      requirements.some(requirement => !isBoundedString(requirement.id) || !isRecoveryReason(requirement.reason))) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The worktree recovery requirements are invalid.')
    }
    const updates = new Map<string, WorktreeRecord>()
    const results: WorktreeRecord[] = []
    const now = this.now()
    for (const requirement of requirements) {
      const current = this.state.records.find(record => record.id === requirement.id)
      if (current === undefined) {
        throw new WorktreeRegistryError('NOT_FOUND', 'A worktree recovery record was not found.')
      }
      if (current.lifecycle === 'removed') {
        throw new WorktreeRegistryError('CONFLICT', 'A removed worktree cannot require recovery.')
      }
      const result = cloneRecord(current)
      const preserveOperationReason = result.lifecycle === 'recovery-required' &&
        (result.recoveryReason === 'create-ambiguous' || result.recoveryReason === 'interrupted-create' ||
          result.recoveryReason === 'interrupted-remove')
      if (!preserveOperationReason &&
        (result.lifecycle !== 'recovery-required' || result.recoveryReason !== requirement.reason)) {
        result.lifecycle = 'recovery-required'
        result.recoveryReason = requirement.reason
        result.updatedAt = monotonicUpdatedAt(now, result)
        updates.set(result.id, result)
      }
      results.push(result)
    }
    if (updates.size > 0) {
      this.commit(next => {
        for (const [id, record] of updates) {
          const index = next.records.findIndex(item => item.id === id)
          if (index < 0) throw new WorktreeRegistryError('NOT_FOUND', 'A worktree recovery record was not found.')
          next.records[index] = record
        }
      })
    }
    return results.map(cloneRecord)
  }

  markOrphanedBatch(ids: readonly string[]): WorktreeRecord[] {
    this.assertAvailable()
    if (new Set(ids).size !== ids.length || ids.some(id => !isBoundedString(id))) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The orphaned worktree identifiers are invalid.')
    }
    const updates = new Map<string, WorktreeRecord>()
    const results: WorktreeRecord[] = []
    const now = this.now()
    for (const id of ids) {
      const current = this.state.records.find(record => record.id === id)
      if (current === undefined) {
        throw new WorktreeRegistryError('NOT_FOUND', 'An orphaned worktree record was not found.')
      }
      if (current.lifecycle === 'orphaned' && current.sessionId === undefined) {
        results.push(cloneRecord(current))
        continue
      }
      if (current.executionMode !== 'worktree' || current.lifecycle !== 'ready' ||
        current.sessionId !== undefined || current.pendingOperation !== undefined) {
        throw new WorktreeRegistryError(
          'CONFLICT',
          'Only a ready managed checkout without a bound Harness session can become orphaned.',
        )
      }
      const result = cloneRecord(current)
      result.lifecycle = 'orphaned'
      result.updatedAt = monotonicUpdatedAt(now, result)
      updates.set(result.id, result)
      results.push(result)
    }
    if (updates.size > 0) {
      this.commit(next => {
        for (const [id, record] of updates) {
          const index = next.records.findIndex(item => item.id === id)
          if (index < 0) throw new WorktreeRegistryError('NOT_FOUND', 'An orphaned worktree record was not found.')
          next.records[index] = record
        }
      })
    }
    return results.map(cloneRecord)
  }

  resolveRecoveryBatch(resolutions: readonly WorktreeRecoveryResolution[]): WorktreeRecord[] {
    this.assertAvailable()
    if (new Set(resolutions.map(resolution => resolution.id)).size !== resolutions.length ||
      resolutions.some(resolution => !isBoundedString(resolution.id) ||
        (resolution.lifecycle !== 'ready' && resolution.lifecycle !== 'orphaned'))) {
      throw new WorktreeRegistryError('BAD_MESSAGE', 'The worktree recovery resolutions are invalid.')
    }
    const updates = new Map<string, WorktreeRecord>()
    const results: WorktreeRecord[] = []
    const now = this.now()
    for (const resolution of resolutions) {
      const current = this.state.records.find(record => record.id === resolution.id)
      if (current === undefined) {
        throw new WorktreeRegistryError('NOT_FOUND', 'A worktree recovery record was not found.')
      }
      if (current.lifecycle !== 'recovery-required') {
        throw new WorktreeRegistryError('CONFLICT', 'The worktree does not require recovery.')
      }
      if (current.pendingOperation?.kind === 'remove') {
        throw new WorktreeRegistryError(
          'CONFLICT',
          'An interrupted removal requires an explicit durable outcome and cannot be cleared as healthy.',
        )
      }
      if (resolution.lifecycle === 'orphaned' &&
        (current.executionMode !== 'worktree' || current.sessionId !== undefined)) {
        throw new WorktreeRegistryError(
          'CONFLICT',
          'Only an unbound managed checkout can recover as orphaned.',
        )
      }
      const result = cloneRecord(current)
      result.lifecycle = resolution.lifecycle
      delete result.pendingOperation
      delete result.recoveryReason
      result.updatedAt = monotonicUpdatedAt(now, result)
      updates.set(result.id, result)
      results.push(result)
    }
    if (updates.size > 0) {
      this.commit(next => {
        for (const [id, record] of updates) {
          const index = next.records.findIndex(item => item.id === id)
          if (index < 0) throw new WorktreeRegistryError('NOT_FOUND', 'A worktree recovery record was not found.')
          next.records[index] = record
        }
      })
    }
    return results.map(cloneRecord)
  }

  resolveRecovery(id: string, resolution: 'ready' | 'orphaned'): WorktreeRecord {
    return this.resolveRecoveryBatch([{ id, lifecycle: resolution }])[0]!
  }

  private recoverInterruptedOperations(): void {
    if (!this.state.records.some(record => record.lifecycle === 'provisioning' || record.lifecycle === 'removing')) {
      return
    }
    this.commit(next => {
      const now = this.now()
      for (const record of next.records) {
        if (record.lifecycle !== 'provisioning' && record.lifecycle !== 'removing') continue
        record.recoveryReason = record.lifecycle === 'provisioning'
          ? 'interrupted-create'
          : 'interrupted-remove'
        record.lifecycle = 'recovery-required'
        record.updatedAt = monotonicUpdatedAt(now, record)
      }
    })
  }

  private transition(id: string, change: (record: WorktreeRecord) => boolean): WorktreeRecord {
    this.assertAvailable()
    const current = this.state.records.find(item => item.id === id)
    if (current === undefined) throw new WorktreeRegistryError('NOT_FOUND', 'The worktree record was not found.')
    const result = cloneRecord(current)
    if (!change(result)) return cloneRecord(current)
    result.updatedAt = monotonicUpdatedAt(this.now(), result)
    this.commit(next => {
      const index = next.records.findIndex(item => item.id === id)
      if (index < 0) throw new WorktreeRegistryError('NOT_FOUND', 'The worktree record was not found.')
      next.records[index] = result
    })
    return cloneRecord(result)
  }

  private commit(change: (next: WorktreeRegistryDocument) => void): void {
    this.assertAvailable()
    const next: WorktreeRegistryDocument = {
      schemaVersion: WORKTREE_REGISTRY_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      records: this.state.records.map(cloneRecord),
    }
    change(next)
    try {
      writeJsonAtomically(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof WorktreeRegistryError) throw error
      this.available = false
      this.unavailableReason = 'The worktree registry could not be persisted safely.'
      throw new WorktreeRegistryError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
  }

  private assertAvailable(): void {
    if (this.available) return
    throw new WorktreeRegistryError(
      'DESKTOP_UNAVAILABLE',
      this.unavailableReason ?? 'The worktree registry is unavailable.',
    )
  }
}
