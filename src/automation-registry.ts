import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import type {
  AutomationDefinition,
  AutomationExecution,
  AutomationRunEvent,
  AutomationRunInvocation,
  AutomationRunPayload,
  AutomationRunSummary,
  AutomationRunTerminalPhase,
  AutomationSnapshot,
  AutomationState,
  AutomationTrigger,
  GitRepositoryIdentity,
} from '@dolphinminer/dsh-desktop-protocol'
import {
  parseAutomationDefinition,
  parseAutomationRunSummary,
  parseAutomationSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'
import {
  isAutomationOccurrence,
  latestDueAutomationOccurrence,
  nextAutomationOccurrence,
  validateAutomationTrigger,
} from './automation-schedule'

export const AUTOMATION_REGISTRY_SCHEMA_VERSION = 1 as const

const MAX_AUTOMATIONS = 10_000
const MAX_RUNS = 50_000
const MAX_DEFINITION_OPERATIONS = 100_000
const MAX_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_DETAIL_LENGTH = 4_096
const VALIDATION_ID = '00000000-0000-4000-8000-000000000000'
const VALIDATION_TIMESTAMP = '1970-01-01T00:00:00.000Z'

export type AutomationDefinitionDraft = Omit<
  AutomationDefinition,
  'id' | 'revision' | 'createdAt' | 'updatedAt'
>

export interface CreateAutomationDefinitionInput {
  operationId: string
  definition: AutomationDefinitionDraft
}

export interface ReplaceAutomationDefinitionInput {
  operationId: string
  automationId: string
  expectedRevision: number
  definition: AutomationDefinitionDraft
}

export interface SetAutomationStateInput {
  operationId: string
  automationId: string
  expectedRevision: number
  state: 'enabled' | 'paused'
  nextTriggerAt?: string
}

export interface DeleteAutomationDefinitionInput {
  operationId: string
  automationId: string
  expectedRevision: number
}

export interface AutomationDefinitionMutationReceipt {
  automationId: string
  revision: number
  state: AutomationState | 'deleted'
  duplicate: boolean
}

export interface QueueAutomationRunInput {
  operationId: string
  automationId: string
  invocation: { kind: 'manual' }
  retryOfRunId?: string
}

export interface AdmitScheduledAutomationRunInput {
  operationId: string
  automationId: string
  expectedRevision: number
  expectedNextTriggerAt: string
  occurrenceAt: string
  nextTriggerAt?: string
}

export interface ScheduledAutomationAdmission {
  automationId: string
  revision: number
  state: AutomationState
  occurrenceAt: string
  decision: 'queued' | 'skipped'
  run?: AutomationRunSummary
  duplicate: boolean
}

export interface ClaimAutomationRunInput {
  operationId: string
  runId: string
  hostInstanceId: string
  workspacePath: string
  worktreeId?: string
}

export interface MarkAutomationRunRunningInput {
  operationId: string
  runId: string
  sessionEventSeq: number
}

export interface RequestAutomationRunCancellationInput {
  operationId: string
  runId: string
  reason?: string
}

export interface FinishAutomationRunInput {
  operationId: string
  runId: string
  outcome: AutomationRunTerminalPhase
  sessionEventSeq?: number
  detail?: string
}

type DefinitionOperationKind = 'create' | 'replace' | 'pause' | 'resume' | 'trigger' | 'delete'

interface DefinitionOperationRecord {
  id: string
  kind: DefinitionOperationKind
  automationId: string
  requestHash: string
  resultRevision: number
  resultState: AutomationState | 'deleted'
  triggerDecision?: 'queued' | 'skipped'
  occurrenceAt?: string
  runId?: string
  at: string
}

interface ActiveAutomationRecord {
  status: 'active'
  definition: AutomationDefinition
}

interface DeletedAutomationRecord {
  status: 'deleted'
  id: string
  revision: number
  createdAt: string
  deletedAt: string
}

type StoredAutomationRecord = ActiveAutomationRecord | DeletedAutomationRecord

interface AutomationRegistryDocument {
  schemaVersion: typeof AUTOMATION_REGISTRY_SCHEMA_VERSION
  revision: number
  records: StoredAutomationRecord[]
  runs: AutomationRunSummary[]
  definitionOperations: DefinitionOperationRecord[]
}

export interface AutomationRegistryOptions {
  now?: () => Date
  randomId?: () => string
  maxAutomations?: number
  maxRuns?: number
  maxDefinitionOperations?: number
}

export class AutomationRegistryError extends Error {
  constructor(
    readonly code:
      | 'BAD_MESSAGE'
      | 'CONFLICT'
      | 'DESKTOP_UNAVAILABLE'
      | 'DUPLICATE_REQUEST'
      | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'AutomationRegistryError'
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

function isUuid(value: unknown): value is string {
  return isBoundedString(value, 36) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  const timestamp = Date.parse(value)
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isCanonicalAbsolutePath(value: string): boolean {
  return value.length <= MAX_PATH_LENGTH && isAbsolute(value) && normalize(value) === value
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function hashAutomationRunPayload(payload: AutomationRunPayload): string {
  return hashJson(payload)
}

function cloneRepository(repository: GitRepositoryIdentity): GitRepositoryIdentity {
  return { ...repository }
}

function cloneTrigger(trigger: AutomationTrigger): AutomationTrigger {
  return { ...trigger }
}

function cloneExecution(execution: AutomationExecution): AutomationExecution {
  return { ...execution }
}

function cloneDefinition(definition: AutomationDefinition): AutomationDefinition {
  return {
    ...definition,
    repository: cloneRepository(definition.repository),
    trigger: cloneTrigger(definition.trigger),
    execution: cloneExecution(definition.execution),
    skillIds: [...definition.skillIds],
    connectionIds: [...definition.connectionIds],
  }
}

function cloneDraft(definition: AutomationDefinitionDraft): AutomationDefinitionDraft {
  return {
    name: definition.name,
    prompt: definition.prompt,
    projectPath: definition.projectPath,
    repository: cloneRepository(definition.repository),
    trigger: cloneTrigger(definition.trigger),
    execution: cloneExecution(definition.execution),
    concurrencyPolicy: definition.concurrencyPolicy,
    skillIds: [...definition.skillIds],
    connectionIds: [...definition.connectionIds],
    state: definition.state,
    ...(definition.nextTriggerAt === undefined ? {} : { nextTriggerAt: definition.nextTriggerAt }),
    ...(definition.lastTriggeredAt === undefined ? {} : { lastTriggeredAt: definition.lastTriggeredAt }),
  }
}

function clonePayload(payload: AutomationRunPayload): AutomationRunPayload {
  return {
    definitionRevision: payload.definitionRevision,
    definitionName: payload.definitionName,
    prompt: payload.prompt,
    projectPath: payload.projectPath,
    repository: cloneRepository(payload.repository),
    trigger: cloneTrigger(payload.trigger),
    execution: cloneExecution(payload.execution),
    concurrencyPolicy: payload.concurrencyPolicy,
    skillIds: [...payload.skillIds],
    connectionIds: [...payload.connectionIds],
    invocation: { ...payload.invocation },
    sessionId: payload.sessionId,
  }
}

function cloneEvent(event: AutomationRunEvent): AutomationRunEvent {
  return { ...event }
}

function cloneRun(run: AutomationRunSummary): AutomationRunSummary {
  return {
    ...run,
    payload: clonePayload(run.payload),
    events: run.events.map(cloneEvent),
  }
}

function cloneStoredRecord(record: StoredAutomationRecord): StoredAutomationRecord {
  return record.status === 'active'
    ? { status: record.status, definition: cloneDefinition(record.definition) }
    : { ...record }
}

function cloneDefinitionOperation(operation: DefinitionOperationRecord): DefinitionOperationRecord {
  return { ...operation }
}

function emptyDocument(): AutomationRegistryDocument {
  return {
    schemaVersion: AUTOMATION_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    records: [],
    runs: [],
    definitionOperations: [],
  }
}

function hasConsistentTriggerState(definition: AutomationDefinition): boolean {
  try {
    validateAutomationTrigger(definition.trigger)
    return !(
      (definition.nextTriggerAt !== undefined &&
        !isAutomationOccurrence(definition.trigger, definition.nextTriggerAt)) ||
      (definition.lastTriggeredAt !== undefined &&
        !isAutomationOccurrence(definition.trigger, definition.lastTriggeredAt)) ||
      (definition.trigger.kind === 'once' && definition.state === 'enabled' &&
        definition.nextTriggerAt !== definition.trigger.at) ||
      (definition.trigger.kind === 'once' && definition.state === 'completed' &&
        definition.lastTriggeredAt !== definition.trigger.at)
    )
  } catch {
    return false
  }
}

function normalizeDraft(value: unknown): AutomationDefinitionDraft {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'name', 'prompt', 'projectPath', 'repository', 'trigger', 'execution', 'concurrencyPolicy',
    'skillIds', 'connectionIds', 'state', 'nextTriggerAt', 'lastTriggeredAt',
  ])) {
    throw new AutomationRegistryError('BAD_MESSAGE', 'The automation definition is invalid.')
  }
  const parsed = parseAutomationDefinition({
    ...value,
    id: VALIDATION_ID,
    revision: 1,
    createdAt: VALIDATION_TIMESTAMP,
    updatedAt: VALIDATION_TIMESTAMP,
  })
  if (parsed === undefined || !isCanonicalAbsolutePath(parsed.projectPath) ||
    !isCanonicalAbsolutePath(parsed.repository.root) || !isCanonicalAbsolutePath(parsed.repository.gitDir) ||
    !isCanonicalAbsolutePath(parsed.repository.commonDir)) {
    throw new AutomationRegistryError('BAD_MESSAGE', 'The automation definition is invalid.')
  }
  if (!hasConsistentTriggerState(parsed)) {
    throw new AutomationRegistryError('BAD_MESSAGE', 'The automation trigger timestamps are inconsistent.')
  }
  return cloneDraft(parsed)
}

function parseStoredRecord(value: unknown): StoredAutomationRecord | undefined {
  if (!isRecord(value) || value.status !== 'active' && value.status !== 'deleted') return undefined
  if (value.status === 'active') {
    if (!hasOnlyKeys(value, ['status', 'definition'])) return undefined
    const definition = parseAutomationDefinition(value.definition)
    if (definition === undefined || !isCanonicalAbsolutePath(definition.projectPath) ||
      !isCanonicalAbsolutePath(definition.repository.root) ||
      !isCanonicalAbsolutePath(definition.repository.gitDir) ||
      !isCanonicalAbsolutePath(definition.repository.commonDir)) return undefined
    if (!hasConsistentTriggerState(definition)) return undefined
    return { status: value.status, definition }
  }
  if (!hasOnlyKeys(value, ['status', 'id', 'revision', 'createdAt', 'deletedAt']) || !isUuid(value.id) ||
    !isPositiveSafeInteger(value.revision) || !isCanonicalIsoDate(value.createdAt) ||
    !isCanonicalIsoDate(value.deletedAt) || Date.parse(value.deletedAt) < Date.parse(value.createdAt)) {
    return undefined
  }
  return {
    status: value.status,
    id: value.id,
    revision: Number(value.revision),
    createdAt: value.createdAt,
    deletedAt: value.deletedAt,
  }
}

function parseDefinitionOperation(value: unknown): DefinitionOperationRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'kind', 'automationId', 'requestHash', 'resultRevision', 'resultState',
    'triggerDecision', 'occurrenceAt', 'runId', 'at',
  ]) || !isBoundedString(value.id) ||
    (value.kind !== 'create' && value.kind !== 'replace' && value.kind !== 'pause' &&
      value.kind !== 'resume' && value.kind !== 'trigger' && value.kind !== 'delete') ||
    !isUuid(value.automationId) || typeof value.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestHash) || !isPositiveSafeInteger(value.resultRevision) ||
    (value.resultState !== 'enabled' && value.resultState !== 'paused' &&
      value.resultState !== 'completed' && value.resultState !== 'deleted') ||
    !isCanonicalIsoDate(value.at)) return undefined
  const hasTriggerFields = value.triggerDecision !== undefined || value.occurrenceAt !== undefined ||
    value.runId !== undefined
  if ((value.kind === 'pause' && value.resultState !== 'paused') ||
    (value.kind === 'resume' && value.resultState !== 'enabled') ||
    (value.kind === 'trigger' &&
      ((value.resultState !== 'enabled' && value.resultState !== 'completed') ||
        (value.triggerDecision !== 'queued' && value.triggerDecision !== 'skipped') ||
        !isCanonicalIsoDate(value.occurrenceAt) ||
        (value.triggerDecision === 'queued') !== isUuid(value.runId) ||
        (value.triggerDecision === 'skipped' && value.runId !== undefined))) ||
    (value.kind !== 'trigger' && hasTriggerFields) ||
    (value.kind === 'delete' && value.resultState !== 'deleted') ||
    (value.kind !== 'delete' && value.resultState === 'deleted')) return undefined
  return {
    id: value.id,
    kind: value.kind,
    automationId: value.automationId,
    requestHash: value.requestHash,
    resultRevision: Number(value.resultRevision),
    resultState: value.resultState,
    ...(value.kind !== 'trigger' ? {} : {
      triggerDecision: value.triggerDecision as 'queued' | 'skipped',
      occurrenceAt: value.occurrenceAt as string,
      ...(value.runId === undefined ? {} : { runId: value.runId as string }),
    }),
    at: value.at,
  }
}

function recordId(record: StoredAutomationRecord): string {
  return record.status === 'active' ? record.definition.id : record.id
}

function recordRevision(record: StoredAutomationRecord): number {
  return record.status === 'active' ? record.definition.revision : record.revision
}

function recordCreatedAt(record: StoredAutomationRecord): string {
  return record.status === 'active' ? record.definition.createdAt : record.createdAt
}

function recordState(record: StoredAutomationRecord): AutomationState | 'deleted' {
  return record.status === 'active' ? record.definition.state : 'deleted'
}

function validateDefinitionHistory(
  record: StoredAutomationRecord,
  operations: readonly DefinitionOperationRecord[],
): boolean {
  if (operations.length === 0 || operations[0]!.kind !== 'create' || operations[0]!.resultRevision !== 1 ||
    operations[0]!.at !== recordCreatedAt(record)) return false
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!
    if (operation.resultRevision !== index + 1 ||
      (index > 0 && Date.parse(operation.at) < Date.parse(operations[index - 1]!.at)) ||
      (index > 0 && operation.kind === 'create') ||
      (index < operations.length - 1 && operation.kind === 'delete')) return false
  }
  const last = operations.at(-1)!
  const updatedAt = record.status === 'active' ? record.definition.updatedAt : record.deletedAt
  return last.resultRevision === recordRevision(record) && last.resultState === recordState(record) &&
    last.at === updatedAt
}

function parseDocument(value: unknown): AutomationRegistryDocument {
  if (value === undefined) return emptyDocument()
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'revision', 'records', 'runs', 'definitionOperations',
  ]) || value.schemaVersion !== AUTOMATION_REGISTRY_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(value.revision) || !Array.isArray(value.records) ||
    value.records.length > MAX_AUTOMATIONS || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS ||
    !Array.isArray(value.definitionOperations) || value.definitionOperations.length > MAX_DEFINITION_OPERATIONS) {
    throw new Error('The automation registry uses an unsupported or invalid document shape.')
  }
  const records = value.records.map(parseStoredRecord)
  const runs = value.runs.map(parseAutomationRunSummary)
  const definitionOperations = value.definitionOperations.map(parseDefinitionOperation)
  if (records.some(record => record === undefined) || runs.some(run => run === undefined) ||
    definitionOperations.some(operation => operation === undefined)) {
    throw new Error('The automation registry contains an invalid record.')
  }
  const exactRecords = records as StoredAutomationRecord[]
  const exactRuns = runs as AutomationRunSummary[]
  const exactOperations = definitionOperations as DefinitionOperationRecord[]
  const ids = exactRecords.map(recordId)
  const runOperationIds = exactRuns.flatMap(run => run.events.map(event => event.operationId))
  const definitionOperationIds = exactOperations.map(operation => operation.id)
  if (new Set(ids).size !== ids.length || new Set(definitionOperationIds).size !== definitionOperationIds.length ||
    new Set(runOperationIds).size !== runOperationIds.length) {
    throw new Error('The automation registry contains duplicate immutable identifiers.')
  }
  const activeDefinitions = exactRecords.flatMap(record =>
    record.status === 'active' ? [record.definition] : [],
  )
  if (parseAutomationSnapshot({
    revision: Number(value.revision),
    automations: activeDefinitions,
    runs: exactRuns,
  }) === undefined) {
    throw new Error('The automation registry contains an invalid public snapshot.')
  }
  const byAutomationId = new Map(exactRecords.map(record => [recordId(record), record]))
  for (const record of exactRecords) {
    const history = exactOperations.filter(operation => operation.automationId === recordId(record))
    if (!validateDefinitionHistory(record, history)) {
      throw new Error('The automation registry contains an invalid definition history.')
    }
  }
  for (const operation of exactOperations) {
    if (!byAutomationId.has(operation.automationId)) {
      throw new Error('The automation registry contains an orphaned definition operation.')
    }
  }
  const runsByOperationId = new Map(exactRuns.flatMap(run =>
    run.events.map(event => [event.operationId, { run, event }] as const),
  ))
  for (const operation of exactOperations) {
    const overlap = runsByOperationId.get(operation.id)
    if (overlap === undefined) continue
    if (operation.kind !== 'trigger' || operation.triggerDecision !== 'queued' ||
      operation.runId !== overlap.run.id || overlap.event.type !== 'queued' ||
      overlap.run.automationId !== operation.automationId ||
      overlap.run.payload.invocation.kind !== 'scheduled' ||
      overlap.run.payload.invocation.occurrenceAt !== operation.occurrenceAt ||
      overlap.run.payload.definitionRevision + 1 !== operation.resultRevision ||
      overlap.event.at !== operation.at) {
      throw new Error('The automation registry contains a conflicting operation identity.')
    }
  }
  for (const run of exactRuns) {
    const record = byAutomationId.get(run.automationId)
    if (record === undefined || run.payload.definitionRevision > recordRevision(record) ||
      Date.parse(run.createdAt) < Date.parse(recordCreatedAt(record)) ||
      (record.status === 'deleted' && Date.parse(run.createdAt) > Date.parse(record.deletedAt)) ||
      hashAutomationRunPayload(run.payload) !== run.payloadHash) {
      throw new Error('The automation registry contains an invalid run identity or payload.')
    }
    if (run.payload.invocation.kind === 'scheduled') {
      const triggerOperation = exactOperations.find(operation => operation.id === run.events[0]!.operationId)
      if (triggerOperation?.kind !== 'trigger' || triggerOperation.runId !== run.id) {
        throw new Error('The automation registry contains an uncommitted scheduled admission.')
      }
    }
  }
  return {
    schemaVersion: AUTOMATION_REGISTRY_SCHEMA_VERSION,
    revision: Number(value.revision),
    records: exactRecords,
    runs: exactRuns,
    definitionOperations: exactOperations,
  }
}

function draftFromDefinition(definition: AutomationDefinition): AutomationDefinitionDraft {
  return cloneDraft(definition)
}

function definitionRequestHash(kind: DefinitionOperationKind, value: unknown): string {
  return hashJson({ kind, value })
}

function queueRequestHash(input: QueueAutomationRunInput): string {
  return hashJson({
    automationId: input.automationId,
    invocation: input.invocation,
    ...(input.retryOfRunId === undefined ? {} : { retryOfRunId: input.retryOfRunId }),
  })
}

function queuedRunRequestHash(run: AutomationRunSummary): string {
  return hashJson({
    automationId: run.automationId,
    invocation: run.payload.invocation.kind === 'manual'
      ? { kind: 'manual' }
      : { kind: 'scheduled', occurrenceAt: run.payload.invocation.occurrenceAt },
    ...(run.retryOfRunId === undefined ? {} : { retryOfRunId: run.retryOfRunId }),
  })
}

function scheduledAdmissionRequestHash(input: AdmitScheduledAutomationRunInput): string {
  return hashJson({
    automationId: input.automationId,
    expectedRevision: input.expectedRevision,
    expectedNextTriggerAt: input.expectedNextTriggerAt,
    occurrenceAt: input.occurrenceAt,
    ...(input.nextTriggerAt === undefined ? {} : { nextTriggerAt: input.nextTriggerAt }),
  })
}

function isTerminal(run: AutomationRunSummary): boolean {
  return run.phase === 'succeeded' || run.phase === 'failed' || run.phase === 'cancelled' ||
    run.phase === 'interrupted' || run.phase === 'ambiguous'
}

function nextRunWithEvent(run: AutomationRunSummary, event: AutomationRunEvent): AutomationRunSummary {
  const cancellationRequested = run.cancellationRequested || event.type === 'cancel-requested' ||
    (event.type === 'terminal' && event.outcome === 'cancelled')
  const phase = event.type === 'dispatch'
    ? 'dispatching'
    : event.type === 'running'
      ? 'running'
      : event.type === 'terminal'
        ? event.outcome
        : run.phase
  const parsed = parseAutomationRunSummary({
    ...run,
    phase,
    cancellationRequested,
    updatedAt: event.at,
    events: [...run.events, event],
  })
  if (parsed === undefined) {
    throw new AutomationRegistryError('CONFLICT', 'The automation run transition is invalid.')
  }
  return parsed
}

export class AutomationRegistry {
  private state: AutomationRegistryDocument = emptyDocument()
  private available = true
  private unavailableReason?: string
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly maxAutomations: number
  private readonly maxRuns: number
  private readonly maxDefinitionOperations: number

  constructor(
    private readonly path: string,
    options: AutomationRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.maxAutomations = Math.max(1, Math.min(options.maxAutomations ?? MAX_AUTOMATIONS, MAX_AUTOMATIONS))
    this.maxRuns = Math.max(1, Math.min(options.maxRuns ?? MAX_RUNS, MAX_RUNS))
    this.maxDefinitionOperations = Math.max(
      1,
      Math.min(options.maxDefinitionOperations ?? MAX_DEFINITION_OPERATIONS, MAX_DEFINITION_OPERATIONS),
    )
    try {
      this.state = parseDocument(readJsonFile(path))
    } catch {
      this.available = false
      this.unavailableReason = 'The automation registry could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  snapshot(): AutomationSnapshot {
    this.assertAvailable()
    return {
      revision: this.state.revision,
      automations: this.state.records.flatMap(record =>
        record.status === 'active' ? [cloneDefinition(record.definition)] : [],
      ),
      runs: this.state.runs.map(cloneRun),
    }
  }

  getDefinition(id: string): AutomationDefinition | undefined {
    this.assertAvailable()
    const record = this.state.records.find(item => recordId(item) === id)
    return record?.status === 'active' ? cloneDefinition(record.definition) : undefined
  }

  getRun(id: string): AutomationRunSummary | undefined {
    this.assertAvailable()
    const run = this.state.runs.find(item => item.id === id)
    return run === undefined ? undefined : cloneRun(run)
  }

  createDefinition(input: CreateAutomationDefinitionInput): AutomationDefinitionMutationReceipt {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    const definition = normalizeDraft(input.definition)
    if (definition.state === 'completed') {
      throw new AutomationRegistryError('BAD_MESSAGE', 'A new automation cannot already be completed.')
    }
    const requestHash = definitionRequestHash('create', definition)
    const duplicate = this.definitionOperationReceipt(input.operationId, 'create', requestHash)
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    if (this.state.records.length >= this.maxAutomations ||
      this.state.definitionOperations.length >= this.maxDefinitionOperations) {
      throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', 'The automation registry is full.')
    }
    const id = this.newUniqueId(new Set(this.state.records.map(recordId)))
    const at = this.nextTimestamp()
    const stored = parseAutomationDefinition({
      ...definition,
      id,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    })!
    const operation: DefinitionOperationRecord = {
      id: input.operationId,
      kind: 'create',
      automationId: id,
      requestHash,
      resultRevision: 1,
      resultState: stored.state,
      at,
    }
    this.commit(next => {
      next.records.push({ status: 'active', definition: stored })
      next.definitionOperations.push(operation)
    })
    return this.receipt(operation, false)
  }

  replaceDefinition(input: ReplaceAutomationDefinitionInput): AutomationDefinitionMutationReceipt {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertAutomationId(input.automationId)
    if (!isPositiveSafeInteger(input.expectedRevision)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The expected automation revision is invalid.')
    }
    const draft = normalizeDraft(input.definition)
    const requestHash = definitionRequestHash('replace', {
      automationId: input.automationId,
      expectedRevision: input.expectedRevision,
      definition: draft,
    })
    const duplicate = this.definitionOperationReceipt(input.operationId, 'replace', requestHash)
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireActiveDefinition(input.automationId, input.expectedRevision)
    return this.storeDefinitionMutation(input.operationId, 'replace', requestHash, current, draft)
  }

  setDefinitionState(input: SetAutomationStateInput): AutomationDefinitionMutationReceipt {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertAutomationId(input.automationId)
    if (!isPositiveSafeInteger(input.expectedRevision) ||
      (input.state === 'paused' && input.nextTriggerAt !== undefined) ||
      (input.state === 'enabled' && !isCanonicalIsoDate(input.nextTriggerAt))) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation state transition is invalid.')
    }
    const kind: DefinitionOperationKind = input.state === 'paused' ? 'pause' : 'resume'
    const requestHash = definitionRequestHash(kind, {
      automationId: input.automationId,
      expectedRevision: input.expectedRevision,
      state: input.state,
      ...(input.nextTriggerAt === undefined ? {} : { nextTriggerAt: input.nextTriggerAt }),
    })
    const duplicate = this.definitionOperationReceipt(input.operationId, kind, requestHash)
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireActiveDefinition(input.automationId, input.expectedRevision)
    if (current.state === input.state) {
      throw new AutomationRegistryError('CONFLICT', `The automation is already ${input.state}.`)
    }
    if (current.state === 'completed') {
      throw new AutomationRegistryError('CONFLICT', 'A completed one-shot automation cannot be resumed or paused.')
    }
    const draft = draftFromDefinition(current)
    draft.state = input.state
    if (input.state === 'paused') delete draft.nextTriggerAt
    else draft.nextTriggerAt = input.nextTriggerAt
    return this.storeDefinitionMutation(input.operationId, kind, requestHash, current, normalizeDraft(draft))
  }

  deleteDefinition(input: DeleteAutomationDefinitionInput): AutomationDefinitionMutationReceipt {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertAutomationId(input.automationId)
    if (!isPositiveSafeInteger(input.expectedRevision)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The expected automation revision is invalid.')
    }
    const requestHash = definitionRequestHash('delete', {
      automationId: input.automationId,
      expectedRevision: input.expectedRevision,
    })
    const duplicate = this.definitionOperationReceipt(input.operationId, 'delete', requestHash)
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireActiveDefinition(input.automationId, input.expectedRevision)
    this.assertDefinitionOperationCapacity()
    const at = this.nextTimestamp(current.updatedAt)
    const operation: DefinitionOperationRecord = {
      id: input.operationId,
      kind: 'delete',
      automationId: current.id,
      requestHash,
      resultRevision: current.revision + 1,
      resultState: 'deleted',
      at,
    }
    this.commit(next => {
      const index = next.records.findIndex(record => recordId(record) === current.id)
      if (index < 0 || next.records[index]!.status !== 'active') {
        throw new AutomationRegistryError('NOT_FOUND', 'The automation definition was not found.')
      }
      next.records[index] = {
        status: 'deleted',
        id: current.id,
        revision: operation.resultRevision,
        createdAt: current.createdAt,
        deletedAt: at,
      }
      next.definitionOperations.push(operation)
    })
    return this.receipt(operation, false)
  }

  queueRun(input: QueueAutomationRunInput): AutomationRunSummary {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertAutomationId(input.automationId)
    if (!isRecord(input.invocation) || input.invocation.kind !== 'manual' ||
      !hasOnlyKeys(input.invocation, ['kind']) ||
      (input.retryOfRunId !== undefined && !isUuid(input.retryOfRunId))) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation run request is invalid.')
    }
    const requestHash = queueRequestHash(input)
    const operationOwner = this.findRunByOperation(input.operationId)
    if (operationOwner !== undefined) {
      const queuedEvent = operationOwner.events[0]
      if (queuedEvent?.type !== 'queued' || operationOwner.automationId !== input.automationId ||
        queuedRunRequestHash(operationOwner) !== requestHash) {
        throw new AutomationRegistryError(
          'DUPLICATE_REQUEST',
          'The automation operation identifier was already used for a different request.',
        )
      }
      return cloneRun(operationOwner)
    }
    this.assertUnusedDefinitionOperationId(input.operationId)
    if (this.state.runs.length >= this.maxRuns) {
      throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', 'The automation run registry is full.')
    }
    const definition = this.requireActiveDefinition(input.automationId)
    let prior: AutomationRunSummary | undefined
    if (input.retryOfRunId !== undefined) {
      prior = this.state.runs.find(run => run.id === input.retryOfRunId)
      if (prior === undefined) {
        throw new AutomationRegistryError('NOT_FOUND', 'The automation run selected for retry was not found.')
      }
      if (prior.automationId !== definition.id || !isTerminal(prior)) {
        throw new AutomationRegistryError('CONFLICT', 'Only a terminal run of this automation can be retried.')
      }
    }
    const at = this.nextTimestamp(definition.updatedAt, prior?.updatedAt)
    const run = this.buildQueuedRun(
      definition,
      input.operationId,
      { kind: 'manual', requestedAt: at },
      at,
      prior,
    )
    this.commit(next => next.runs.push(run))
    return cloneRun(run)
  }

  admitScheduledRun(input: AdmitScheduledAutomationRunInput): ScheduledAutomationAdmission {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertAutomationId(input.automationId)
    if (!isPositiveSafeInteger(input.expectedRevision) ||
      !isCanonicalIsoDate(input.expectedNextTriggerAt) || !isCanonicalIsoDate(input.occurrenceAt) ||
      (input.nextTriggerAt !== undefined && !isCanonicalIsoDate(input.nextTriggerAt))) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The scheduled automation admission is invalid.')
    }
    const requestHash = scheduledAdmissionRequestHash(input)
    const existingOperation = this.state.definitionOperations.find(operation => operation.id === input.operationId)
    if (existingOperation !== undefined) {
      if (existingOperation.kind !== 'trigger' || existingOperation.requestHash !== requestHash) {
        throw new AutomationRegistryError(
          'DUPLICATE_REQUEST',
          'The automation operation identifier was already used for a different request.',
        )
      }
      return this.scheduledAdmission(existingOperation, true)
    }
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireActiveDefinition(input.automationId, input.expectedRevision)
    if (current.state !== 'enabled' || current.nextTriggerAt !== input.expectedNextTriggerAt) {
      throw new AutomationRegistryError('CONFLICT', 'The automation trigger state or next occurrence has changed.')
    }
    const due = latestDueAutomationOccurrence(current.trigger, current.nextTriggerAt, this.now())
    if (due !== input.occurrenceAt) {
      throw new AutomationRegistryError('CONFLICT', 'The requested occurrence is not the latest due trigger.')
    }
    const calculatedNext = nextAutomationOccurrence(current.trigger, input.occurrenceAt)
    if (calculatedNext !== input.nextTriggerAt) {
      throw new AutomationRegistryError('CONFLICT', 'The next automation trigger does not follow the due occurrence.')
    }
    this.assertDefinitionOperationCapacity()
    const activeRuns = this.state.runs.filter(run => run.automationId === current.id && !isTerminal(run))
    const decision: 'queued' | 'skipped' = activeRuns.length > 0 &&
      (current.concurrencyPolicy === 'skip' || activeRuns.some(run => run.phase === 'queued'))
      ? 'skipped'
      : 'queued'
    if (decision === 'queued' && this.state.runs.length >= this.maxRuns) {
      throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', 'The automation run registry is full.')
    }
    const at = this.nextTimestamp(current.updatedAt)
    const advancedDraft = draftFromDefinition(current)
    advancedDraft.state = current.trigger.kind === 'once' ? 'completed' : 'enabled'
    advancedDraft.lastTriggeredAt = input.occurrenceAt
    if (calculatedNext === undefined) delete advancedDraft.nextTriggerAt
    else advancedDraft.nextTriggerAt = calculatedNext
    const updated = parseAutomationDefinition({
      ...advancedDraft,
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: at,
    })
    if (updated === undefined) {
      throw new AutomationRegistryError('CONFLICT', 'The scheduled automation could not advance safely.')
    }
    const run = decision === 'queued'
      ? this.buildQueuedRun(
          current,
          input.operationId,
          { kind: 'scheduled', occurrenceAt: input.occurrenceAt },
          at,
        )
      : undefined
    const operation: DefinitionOperationRecord = {
      id: input.operationId,
      kind: 'trigger',
      automationId: current.id,
      requestHash,
      resultRevision: updated.revision,
      resultState: updated.state,
      triggerDecision: decision,
      occurrenceAt: input.occurrenceAt,
      ...(run === undefined ? {} : { runId: run.id }),
      at,
    }
    this.commit(next => {
      const index = next.records.findIndex(record => recordId(record) === current.id)
      if (index < 0 || next.records[index]!.status !== 'active') {
        throw new AutomationRegistryError('NOT_FOUND', 'The automation definition was not found.')
      }
      next.records[index] = { status: 'active', definition: updated }
      next.definitionOperations.push(operation)
      if (run !== undefined) next.runs.push(run)
    })
    return this.scheduledAdmission(operation, false)
  }

  claimRun(input: ClaimAutomationRunInput): AutomationRunSummary {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertRunId(input.runId)
    if (!isBoundedString(input.hostInstanceId) || !isCanonicalAbsolutePath(input.workspacePath) ||
      (input.worktreeId !== undefined && !isUuid(input.worktreeId))) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation dispatch claim is invalid.')
    }
    const duplicate = this.matchExistingRunOperation(input.operationId, input.runId, event =>
      event.type === 'dispatch' && event.hostInstanceId === input.hostInstanceId &&
      event.workspacePath === input.workspacePath && event.worktreeId === input.worktreeId,
    )
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireRun(input.runId)
    if (current.phase !== 'queued' || current.cancellationRequested) {
      throw new AutomationRegistryError('CONFLICT', 'Only an uncancelled queued run can be claimed.')
    }
    if (this.state.runs.some(run => run.id !== current.id && run.automationId === current.automationId &&
      (run.phase === 'dispatching' || run.phase === 'running'))) {
      throw new AutomationRegistryError('CONFLICT', 'Another run of this automation still owns execution.')
    }
    return this.appendRunEvent(current, {
      seq: current.events.length + 1,
      operationId: input.operationId,
      at: this.nextTimestamp(current.updatedAt),
      type: 'dispatch',
      hostInstanceId: input.hostInstanceId,
      workspacePath: input.workspacePath,
      ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    })
  }

  markRunRunning(input: MarkAutomationRunRunningInput): AutomationRunSummary {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertRunId(input.runId)
    if (!isNonNegativeSafeInteger(input.sessionEventSeq)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The Harness session event sequence is invalid.')
    }
    const duplicate = this.matchExistingRunOperation(input.operationId, input.runId, event =>
      event.type === 'running' && event.sessionEventSeq === input.sessionEventSeq,
    )
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireRun(input.runId)
    if (current.phase !== 'dispatching') {
      throw new AutomationRegistryError('CONFLICT', 'Only a dispatching run can become running.')
    }
    return this.appendRunEvent(current, {
      seq: current.events.length + 1,
      operationId: input.operationId,
      at: this.nextTimestamp(current.updatedAt),
      type: 'running',
      sessionEventSeq: input.sessionEventSeq,
    })
  }

  requestRunCancellation(input: RequestAutomationRunCancellationInput): AutomationRunSummary {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertRunId(input.runId)
    if (input.reason !== undefined && !isBoundedString(input.reason, MAX_DETAIL_LENGTH)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation cancellation reason is invalid.')
    }
    const duplicate = this.matchExistingRunOperation(input.operationId, input.runId, event =>
      (event.type === 'cancel-requested' && event.reason === input.reason) ||
      (event.type === 'terminal' && event.outcome === 'cancelled' && event.detail === input.reason),
    )
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireRun(input.runId)
    if (isTerminal(current)) {
      throw new AutomationRegistryError('CONFLICT', 'A terminal automation run cannot be cancelled.')
    }
    if (current.cancellationRequested) {
      throw new AutomationRegistryError('CONFLICT', 'Cancellation was already requested for this run.')
    }
    const at = this.nextTimestamp(current.updatedAt)
    if (current.phase === 'queued') {
      return this.appendRunEvent(current, {
        seq: current.events.length + 1,
        operationId: input.operationId,
        at,
        type: 'terminal',
        outcome: 'cancelled',
        ...(input.reason === undefined ? {} : { detail: input.reason }),
      })
    }
    return this.appendRunEvent(current, {
      seq: current.events.length + 1,
      operationId: input.operationId,
      at,
      type: 'cancel-requested',
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
  }

  finishRun(input: FinishAutomationRunInput): AutomationRunSummary {
    this.assertAvailable()
    this.assertOperationId(input.operationId)
    this.assertRunId(input.runId)
    if ((input.outcome !== 'succeeded' && input.outcome !== 'failed' && input.outcome !== 'cancelled' &&
      input.outcome !== 'interrupted' && input.outcome !== 'ambiguous') ||
      (input.sessionEventSeq !== undefined && !isNonNegativeSafeInteger(input.sessionEventSeq)) ||
      (input.detail !== undefined && !isBoundedString(input.detail, MAX_DETAIL_LENGTH))) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation terminal result is invalid.')
    }
    const duplicate = this.matchExistingRunOperation(input.operationId, input.runId, event =>
      event.type === 'terminal' && event.outcome === input.outcome &&
      event.sessionEventSeq === input.sessionEventSeq && event.detail === input.detail,
    )
    if (duplicate !== undefined) return duplicate
    this.assertUnusedOperationId(input.operationId)
    const current = this.requireRun(input.runId)
    if (isTerminal(current)) {
      throw new AutomationRegistryError('CONFLICT', 'A terminal automation run cannot be overwritten.')
    }
    if (input.outcome === 'succeeded' && current.phase !== 'running') {
      throw new AutomationRegistryError('CONFLICT', 'Only a running automation can succeed.')
    }
    if ((input.outcome === 'interrupted' || input.outcome === 'ambiguous') && current.phase === 'queued') {
      throw new AutomationRegistryError('CONFLICT', 'A run cannot be interrupted or ambiguous before dispatch.')
    }
    const runningEvent = current.events.find(event => event.type === 'running')
    if (runningEvent?.type === 'running' && input.sessionEventSeq !== undefined &&
      input.sessionEventSeq < runningEvent.sessionEventSeq) {
      throw new AutomationRegistryError('CONFLICT', 'The terminal session evidence predates the running event.')
    }
    return this.appendRunEvent(current, {
      seq: current.events.length + 1,
      operationId: input.operationId,
      at: this.nextTimestamp(current.updatedAt),
      type: 'terminal',
      outcome: input.outcome,
      ...(input.sessionEventSeq === undefined ? {} : { sessionEventSeq: input.sessionEventSeq }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    })
  }

  private buildQueuedRun(
    definition: AutomationDefinition,
    operationId: string,
    invocation: AutomationRunInvocation,
    at: string,
    prior?: AutomationRunSummary,
  ): AutomationRunSummary {
    const runId = this.newUniqueId(new Set(this.state.runs.map(run => run.id)))
    const sessionId = this.newUniqueId(new Set(this.state.runs.map(run => run.payload.sessionId)))
    const payload: AutomationRunPayload = {
      definitionRevision: definition.revision,
      definitionName: definition.name,
      prompt: definition.prompt,
      projectPath: definition.projectPath,
      repository: cloneRepository(definition.repository),
      trigger: cloneTrigger(definition.trigger),
      execution: cloneExecution(definition.execution),
      concurrencyPolicy: definition.concurrencyPolicy,
      skillIds: [...definition.skillIds],
      connectionIds: [...definition.connectionIds],
      invocation: { ...invocation },
      sessionId,
    }
    const run = parseAutomationRunSummary({
      id: runId,
      automationId: definition.id,
      ...(prior === undefined ? {} : { retryOfRunId: prior.id }),
      payloadHash: hashAutomationRunPayload(payload),
      payload,
      phase: 'queued',
      cancellationRequested: false,
      createdAt: at,
      updatedAt: at,
      events: [{ seq: 1, operationId, at, type: 'queued' }],
    })
    if (run === undefined) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The immutable automation run payload is invalid.')
    }
    return run
  }

  private scheduledAdmission(
    operation: DefinitionOperationRecord,
    duplicate: boolean,
  ): ScheduledAutomationAdmission {
    if (operation.kind !== 'trigger' || operation.triggerDecision === undefined ||
      operation.occurrenceAt === undefined || operation.resultState === 'deleted') {
      throw new AutomationRegistryError('DUPLICATE_REQUEST', 'The trigger operation identity is invalid.')
    }
    const run = operation.runId === undefined
      ? undefined
      : this.state.runs.find(item => item.id === operation.runId)
    if ((operation.triggerDecision === 'queued') !== (run !== undefined)) {
      throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', 'The scheduled run identity is unavailable.')
    }
    return {
      automationId: operation.automationId,
      revision: operation.resultRevision,
      state: operation.resultState,
      occurrenceAt: operation.occurrenceAt,
      decision: operation.triggerDecision,
      ...(run === undefined ? {} : { run: cloneRun(run) }),
      duplicate,
    }
  }

  private storeDefinitionMutation(
    operationId: string,
    kind: Exclude<DefinitionOperationKind, 'create' | 'trigger' | 'delete'>,
    requestHash: string,
    current: AutomationDefinition,
    draft: AutomationDefinitionDraft,
  ): AutomationDefinitionMutationReceipt {
    this.assertDefinitionOperationCapacity()
    const at = this.nextTimestamp(current.updatedAt)
    const updated = parseAutomationDefinition({
      ...draft,
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: at,
    })
    if (updated === undefined) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The updated automation definition is invalid.')
    }
    const operation: DefinitionOperationRecord = {
      id: operationId,
      kind,
      automationId: current.id,
      requestHash,
      resultRevision: updated.revision,
      resultState: updated.state,
      at,
    }
    this.commit(next => {
      const index = next.records.findIndex(record => recordId(record) === current.id)
      if (index < 0 || next.records[index]!.status !== 'active') {
        throw new AutomationRegistryError('NOT_FOUND', 'The automation definition was not found.')
      }
      next.records[index] = { status: 'active', definition: updated }
      next.definitionOperations.push(operation)
    })
    return this.receipt(operation, false)
  }

  private appendRunEvent(current: AutomationRunSummary, event: AutomationRunEvent): AutomationRunSummary {
    const updated = nextRunWithEvent(current, event)
    this.commit(next => {
      const index = next.runs.findIndex(run => run.id === current.id)
      if (index < 0) throw new AutomationRegistryError('NOT_FOUND', 'The automation run was not found.')
      next.runs[index] = updated
    })
    return cloneRun(updated)
  }

  private requireActiveDefinition(id: string, expectedRevision?: number): AutomationDefinition {
    const record = this.state.records.find(item => recordId(item) === id)
    if (record === undefined || record.status !== 'active') {
      throw new AutomationRegistryError('NOT_FOUND', 'The automation definition was not found.')
    }
    if (expectedRevision !== undefined && record.definition.revision !== expectedRevision) {
      throw new AutomationRegistryError('CONFLICT', 'The automation definition revision has changed.')
    }
    return cloneDefinition(record.definition)
  }

  private requireRun(id: string): AutomationRunSummary {
    const run = this.state.runs.find(item => item.id === id)
    if (run === undefined) throw new AutomationRegistryError('NOT_FOUND', 'The automation run was not found.')
    return cloneRun(run)
  }

  private definitionOperationReceipt(
    operationId: string,
    kind: DefinitionOperationKind,
    requestHash: string,
  ): AutomationDefinitionMutationReceipt | undefined {
    const operation = this.state.definitionOperations.find(item => item.id === operationId)
    if (operation === undefined) return undefined
    if (operation.kind !== kind || operation.requestHash !== requestHash) {
      throw new AutomationRegistryError(
        'DUPLICATE_REQUEST',
        'The automation operation identifier was already used for a different request.',
      )
    }
    return this.receipt(operation, true)
  }

  private receipt(
    operation: DefinitionOperationRecord,
    duplicate: boolean,
  ): AutomationDefinitionMutationReceipt {
    return {
      automationId: operation.automationId,
      revision: operation.resultRevision,
      state: operation.resultState,
      duplicate,
    }
  }

  private findRunByOperation(operationId: string): AutomationRunSummary | undefined {
    return this.state.runs.find(run => run.events.some(event => event.operationId === operationId))
  }

  private matchExistingRunOperation(
    operationId: string,
    runId: string,
    matches: (event: AutomationRunEvent) => boolean,
  ): AutomationRunSummary | undefined {
    const owner = this.findRunByOperation(operationId)
    if (owner === undefined) return undefined
    const event = owner.events.find(item => item.operationId === operationId)!
    if (owner.id !== runId || !matches(event)) {
      throw new AutomationRegistryError(
        'DUPLICATE_REQUEST',
        'The automation operation identifier was already used for a different request.',
      )
    }
    return cloneRun(owner)
  }

  private assertOperationId(operationId: string): void {
    if (!isBoundedString(operationId)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation operation identifier is invalid.')
    }
  }

  private assertAutomationId(automationId: string): void {
    if (!isUuid(automationId)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation identifier is invalid.')
    }
  }

  private assertRunId(runId: string): void {
    if (!isUuid(runId)) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation run identifier is invalid.')
    }
  }

  private assertUnusedDefinitionOperationId(operationId: string): void {
    if (this.state.definitionOperations.some(operation => operation.id === operationId)) {
      throw new AutomationRegistryError(
        'DUPLICATE_REQUEST',
        'The automation operation identifier has already been used.',
      )
    }
  }

  private assertUnusedOperationId(operationId: string): void {
    this.assertUnusedDefinitionOperationId(operationId)
    if (this.findRunByOperation(operationId) !== undefined) {
      throw new AutomationRegistryError(
        'DUPLICATE_REQUEST',
        'The automation operation identifier has already been used.',
      )
    }
  }

  private assertDefinitionOperationCapacity(): void {
    if (this.state.definitionOperations.length >= this.maxDefinitionOperations) {
      throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', 'The automation operation registry is full.')
    }
  }

  private nextTimestamp(...previous: Array<string | undefined>): string {
    const now = this.now().getTime()
    const floor = Math.max(now, ...previous.flatMap(value => value === undefined ? [] : [Date.parse(value)]))
    return new Date(floor).toISOString()
  }

  private newUniqueId(existing: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.randomId()
      if (isUuid(id) && !existing.has(id)) return id
    }
    throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', 'A unique automation identifier could not be created.')
  }

  private commit(change: (next: AutomationRegistryDocument) => void): void {
    this.assertAvailable()
    const candidate: AutomationRegistryDocument = {
      schemaVersion: AUTOMATION_REGISTRY_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      records: this.state.records.map(cloneStoredRecord),
      runs: this.state.runs.map(cloneRun),
      definitionOperations: this.state.definitionOperations.map(cloneDefinitionOperation),
    }
    change(candidate)
    try {
      const next = parseDocument(candidate)
      writeJsonAtomically(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof AutomationRegistryError) throw error
      this.available = false
      this.unavailableReason = 'The automation registry could not be persisted safely.'
      throw new AutomationRegistryError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
  }

  private assertAvailable(): void {
    if (this.available) return
    throw new AutomationRegistryError(
      'DESKTOP_UNAVAILABLE',
      this.unavailableReason ?? 'The automation registry is unavailable.',
    )
  }
}
