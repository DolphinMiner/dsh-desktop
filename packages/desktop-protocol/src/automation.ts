import type { GitRepositoryIdentity } from './git.js'
import { parseGitRepositoryIdentity } from './git.js'

const MAX_ID_LENGTH = 256
const MAX_NAME_LENGTH = 120
const MAX_PROMPT_LENGTH = 100_000
const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024
const MAX_CRON_LENGTH = 256
const MAX_TIME_ZONE_LENGTH = 256
const MAX_DETAIL_LENGTH = 4_096
const MAX_REFERENCES = 128
const MAX_AUTOMATIONS = 10_000
const MAX_RUNS = 50_000
const MAX_RUN_EVENTS = 16
export const MAX_TASK_CENTER_RECENT_RUNS = 100 as const

export type AutomationState = 'enabled' | 'paused' | 'completed'
export type AutomationConcurrencyPolicy = 'skip' | 'queue-one'

export type AutomationTrigger = {
  kind: 'once'
  at: string
} | {
  kind: 'cron'
  expression: string
  timeZone: string
}

export type AutomationExecution = {
  mode: 'worktree'
  baseRef: string
} | {
  mode: 'local'
}

export interface AutomationDefinition {
  id: string
  revision: number
  name: string
  prompt: string
  projectPath: string
  repository: GitRepositoryIdentity
  trigger: AutomationTrigger
  execution: AutomationExecution
  concurrencyPolicy: AutomationConcurrencyPolicy
  skillIds: string[]
  connectionIds: string[]
  state: AutomationState
  nextTriggerAt?: string
  lastTriggeredAt?: string
  createdAt: string
  updatedAt: string
}

export type AutomationRunInvocation = {
  kind: 'manual'
  requestedAt: string
} | {
  kind: 'scheduled'
  occurrenceAt: string
}

export interface AutomationRunPayload {
  definitionRevision: number
  definitionName: string
  prompt: string
  projectPath: string
  repository: GitRepositoryIdentity
  trigger: AutomationTrigger
  execution: AutomationExecution
  concurrencyPolicy: AutomationConcurrencyPolicy
  skillIds: string[]
  connectionIds: string[]
  invocation: AutomationRunInvocation
  sessionId: string
}

export type AutomationRunPhase =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'ambiguous'

export type AutomationRunTerminalPhase = Extract<
  AutomationRunPhase,
  'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'ambiguous'
>

interface AutomationRunEventBase {
  seq: number
  operationId: string
  at: string
}

export interface AutomationRunQueuedEvent extends AutomationRunEventBase {
  type: 'queued'
}

export interface AutomationRunDispatchEvent extends AutomationRunEventBase {
  type: 'dispatch'
  hostInstanceId: string
  workspacePath: string
  worktreeId?: string
}

export interface AutomationRunRunningEvent extends AutomationRunEventBase {
  type: 'running'
  sessionEventSeq: number
}

export interface AutomationRunCancelRequestedEvent extends AutomationRunEventBase {
  type: 'cancel-requested'
  reason?: string
}

export interface AutomationRunTerminalEvent extends AutomationRunEventBase {
  type: 'terminal'
  outcome: AutomationRunTerminalPhase
  sessionEventSeq?: number
  detail?: string
}

export type AutomationRunEvent =
  | AutomationRunQueuedEvent
  | AutomationRunDispatchEvent
  | AutomationRunRunningEvent
  | AutomationRunCancelRequestedEvent
  | AutomationRunTerminalEvent

export interface AutomationRunSummary {
  id: string
  automationId: string
  retryOfRunId?: string
  payloadHash: string
  payload: AutomationRunPayload
  phase: AutomationRunPhase
  cancellationRequested: boolean
  createdAt: string
  updatedAt: string
  events: AutomationRunEvent[]
}

export interface AutomationSnapshot {
  revision: number
  automations: AutomationDefinition[]
  runs: AutomationRunSummary[]
}

export type DesktopAutomationExecutionInput = {
  mode: 'worktree'
  baseRef: string
} | {
  mode: 'local'
  localCheckoutAcknowledged: true
}

export interface DesktopCreateAutomationInput {
  operationId: string
  requestedAt: string
  name: string
  prompt: string
  projectPath: string
  trigger: AutomationTrigger
  execution: DesktopAutomationExecutionInput
  concurrencyPolicy: AutomationConcurrencyPolicy
  skillIds: string[]
  connectionIds: string[]
}

export interface DesktopSetAutomationStateInput {
  operationId: string
  requestedAt: string
  automationId: string
  expectedRevision: number
  state: 'enabled' | 'paused'
}

export interface DesktopDeleteAutomationInput {
  operationId: string
  automationId: string
  expectedRevision: number
}

export interface DesktopQueueAutomationRunInput {
  operationId: string
  automationId: string
  retryOfRunId?: string
}

export interface DesktopCancelAutomationRunInput {
  operationId: string
  runId: string
}

export interface DesktopOpenAutomationSessionInput {
  sessionId: string
}

export interface DesktopListAutomationRunsInput {
  expectedRevision: number
  beforeRunId: string
  limit: number
}

export interface AutomationTaskCenterSnapshot {
  revision: number
  automations: AutomationDefinition[]
  recentRuns: AutomationRunSummary[]
  totalRunCount: number
  executionAvailability: 'requires-app-running'
}

export interface AutomationChangedNotice {
  revision: number
}

export interface AutomationRunPage {
  revision: number
  runs: AutomationRunSummary[]
  totalRunCount: number
  nextBeforeRunId?: string
}

export interface AutomationClaimNextParams {
  hostInstanceId: string
}

export interface AutomationDispatchClaim {
  run: AutomationRunSummary
  workspacePath: string
  worktreeId?: string
}

export interface AutomationClaimNextResult {
  dispatch?: AutomationDispatchClaim
}

export interface AutomationInspectOwnedResult {
  run?: AutomationRunSummary
}

export interface AutomationMarkRunningParams extends AutomationClaimNextParams {
  runId: string
  sessionEventSeq: number
}

export interface AutomationFinishParams extends AutomationClaimNextParams {
  runId: string
  outcome: AutomationRunTerminalPhase
  sessionEventSeq?: number
  detail?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isBoundedString(value: unknown, maxLength: number): value is string {
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

function parseExactRepositoryIdentity(value: unknown): GitRepositoryIdentity | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['root', 'gitDir', 'commonDir'])) return undefined
  return parseGitRepositoryIdentity(value)
}

function parseReferenceList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES ||
    value.some(item => !isBoundedString(item, MAX_ID_LENGTH)) || new Set(value).size !== value.length) return undefined
  return [...value] as string[]
}

function parseConcurrencyPolicy(value: unknown): AutomationConcurrencyPolicy | undefined {
  return value === 'skip' || value === 'queue-one' ? value : undefined
}

export function parseAutomationTrigger(value: unknown): AutomationTrigger | undefined {
  if (!isRecord(value) || (value.kind !== 'once' && value.kind !== 'cron')) return undefined
  if (value.kind === 'once') {
    return hasOnlyKeys(value, ['kind', 'at']) && isCanonicalIsoDate(value.at)
      ? { kind: value.kind, at: value.at }
      : undefined
  }
  if (!hasOnlyKeys(value, ['kind', 'expression', 'timeZone']) ||
    !isBoundedString(value.expression, MAX_CRON_LENGTH) || value.expression.trim() !== value.expression ||
    value.expression.split(/\s+/).length !== 5 || /[^\x21-\x7e ]/.test(value.expression) ||
    !isBoundedString(value.timeZone, MAX_TIME_ZONE_LENGTH) ||
    !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value.timeZone)) return undefined
  return { kind: value.kind, expression: value.expression, timeZone: value.timeZone }
}

export function parseAutomationExecution(value: unknown): AutomationExecution | undefined {
  if (!isRecord(value) || (value.mode !== 'worktree' && value.mode !== 'local')) return undefined
  if (value.mode === 'local') return hasOnlyKeys(value, ['mode']) ? { mode: value.mode } : undefined
  if (!hasOnlyKeys(value, ['mode', 'baseRef']) || !isBoundedString(value.baseRef, MAX_REF_LENGTH) ||
    /[\r\n]/.test(value.baseRef)) return undefined
  return { mode: value.mode, baseRef: value.baseRef }
}

export function parseAutomationDefinition(value: unknown): AutomationDefinition | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'revision', 'name', 'prompt', 'projectPath', 'repository', 'trigger', 'execution',
    'concurrencyPolicy', 'skillIds', 'connectionIds', 'state', 'nextTriggerAt', 'lastTriggeredAt',
    'createdAt', 'updatedAt',
  ]) || !isUuid(value.id) || !isPositiveSafeInteger(value.revision) ||
    !isBoundedString(value.name, MAX_NAME_LENGTH) || value.name.trim() !== value.name ||
    !isBoundedString(value.prompt, MAX_PROMPT_LENGTH) || value.prompt.trim() !== value.prompt ||
    !isBoundedString(value.projectPath, MAX_PATH_LENGTH) ||
    (value.state !== 'enabled' && value.state !== 'paused' && value.state !== 'completed') ||
    !isCanonicalIsoDate(value.createdAt) || !isCanonicalIsoDate(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    (value.nextTriggerAt !== undefined && !isCanonicalIsoDate(value.nextTriggerAt)) ||
    (value.lastTriggeredAt !== undefined && !isCanonicalIsoDate(value.lastTriggeredAt))) return undefined
  const repository = parseExactRepositoryIdentity(value.repository)
  const trigger = parseAutomationTrigger(value.trigger)
  const execution = parseAutomationExecution(value.execution)
  const concurrencyPolicy = parseConcurrencyPolicy(value.concurrencyPolicy)
  const skillIds = parseReferenceList(value.skillIds)
  const connectionIds = parseReferenceList(value.connectionIds)
  if (repository === undefined || trigger === undefined || execution === undefined || concurrencyPolicy === undefined ||
    skillIds === undefined || connectionIds === undefined ||
    (value.state === 'enabled') !== (value.nextTriggerAt !== undefined) ||
    (value.state === 'completed' && trigger.kind !== 'once') ||
    (value.lastTriggeredAt !== undefined && value.nextTriggerAt !== undefined &&
      Date.parse(value.nextTriggerAt) <= Date.parse(value.lastTriggeredAt))) return undefined
  return {
    id: value.id,
    revision: Number(value.revision),
    name: value.name,
    prompt: value.prompt,
    projectPath: value.projectPath,
    repository,
    trigger,
    execution,
    concurrencyPolicy,
    skillIds,
    connectionIds,
    state: value.state,
    ...(value.nextTriggerAt === undefined ? {} : { nextTriggerAt: value.nextTriggerAt }),
    ...(value.lastTriggeredAt === undefined ? {} : { lastTriggeredAt: value.lastTriggeredAt }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function parseRunInvocation(value: unknown): AutomationRunInvocation | undefined {
  if (!isRecord(value) || (value.kind !== 'manual' && value.kind !== 'scheduled')) return undefined
  if (value.kind === 'manual') {
    return hasOnlyKeys(value, ['kind', 'requestedAt']) && isCanonicalIsoDate(value.requestedAt)
      ? { kind: value.kind, requestedAt: value.requestedAt }
      : undefined
  }
  return hasOnlyKeys(value, ['kind', 'occurrenceAt']) && isCanonicalIsoDate(value.occurrenceAt)
    ? { kind: value.kind, occurrenceAt: value.occurrenceAt }
    : undefined
}

export function parseAutomationRunPayload(value: unknown): AutomationRunPayload | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'definitionRevision', 'definitionName', 'prompt', 'projectPath', 'repository', 'trigger', 'execution',
    'concurrencyPolicy', 'skillIds', 'connectionIds', 'invocation', 'sessionId',
  ]) || !isPositiveSafeInteger(value.definitionRevision) ||
    !isBoundedString(value.definitionName, MAX_NAME_LENGTH) || value.definitionName.trim() !== value.definitionName ||
    !isBoundedString(value.prompt, MAX_PROMPT_LENGTH) || value.prompt.trim() !== value.prompt ||
    !isBoundedString(value.projectPath, MAX_PATH_LENGTH) || !isUuid(value.sessionId)) return undefined
  const repository = parseExactRepositoryIdentity(value.repository)
  const trigger = parseAutomationTrigger(value.trigger)
  const execution = parseAutomationExecution(value.execution)
  const concurrencyPolicy = parseConcurrencyPolicy(value.concurrencyPolicy)
  const skillIds = parseReferenceList(value.skillIds)
  const connectionIds = parseReferenceList(value.connectionIds)
  const invocation = parseRunInvocation(value.invocation)
  if (repository === undefined || trigger === undefined || execution === undefined || concurrencyPolicy === undefined ||
    skillIds === undefined || connectionIds === undefined || invocation === undefined) return undefined
  return {
    definitionRevision: Number(value.definitionRevision),
    definitionName: value.definitionName,
    prompt: value.prompt,
    projectPath: value.projectPath,
    repository,
    trigger,
    execution,
    concurrencyPolicy,
    skillIds,
    connectionIds,
    invocation,
    sessionId: value.sessionId,
  }
}

export function parseAutomationRunEvent(value: unknown): AutomationRunEvent | undefined {
  if (!isRecord(value) || !isPositiveSafeInteger(value.seq) || !isBoundedString(value.operationId, MAX_ID_LENGTH) ||
    !isCanonicalIsoDate(value.at) || !isBoundedString(value.type, 32)) return undefined
  const base = { seq: Number(value.seq), operationId: value.operationId, at: value.at }
  if (value.type === 'queued') {
    return hasOnlyKeys(value, ['seq', 'operationId', 'at', 'type']) ? { ...base, type: value.type } : undefined
  }
  if (value.type === 'dispatch') {
    if (!hasOnlyKeys(value, [
      'seq', 'operationId', 'at', 'type', 'hostInstanceId', 'workspacePath', 'worktreeId',
    ]) || !isBoundedString(value.hostInstanceId, MAX_ID_LENGTH) ||
      !isBoundedString(value.workspacePath, MAX_PATH_LENGTH) ||
      (value.worktreeId !== undefined && !isUuid(value.worktreeId))) return undefined
    return {
      ...base,
      type: value.type,
      hostInstanceId: value.hostInstanceId,
      workspacePath: value.workspacePath,
      ...(value.worktreeId === undefined ? {} : { worktreeId: value.worktreeId }),
    }
  }
  if (value.type === 'running') {
    return hasOnlyKeys(value, ['seq', 'operationId', 'at', 'type', 'sessionEventSeq']) &&
      isNonNegativeSafeInteger(value.sessionEventSeq)
      ? { ...base, type: value.type, sessionEventSeq: Number(value.sessionEventSeq) }
      : undefined
  }
  if (value.type === 'cancel-requested') {
    if (!hasOnlyKeys(value, ['seq', 'operationId', 'at', 'type', 'reason']) ||
      (value.reason !== undefined && !isBoundedString(value.reason, MAX_DETAIL_LENGTH))) return undefined
    return { ...base, type: value.type, ...(value.reason === undefined ? {} : { reason: value.reason }) }
  }
  if (value.type !== 'terminal' || !hasOnlyKeys(value, [
    'seq', 'operationId', 'at', 'type', 'outcome', 'sessionEventSeq', 'detail',
  ]) || (value.outcome !== 'succeeded' && value.outcome !== 'failed' && value.outcome !== 'cancelled' &&
    value.outcome !== 'interrupted' && value.outcome !== 'ambiguous') ||
    (value.sessionEventSeq !== undefined && !isNonNegativeSafeInteger(value.sessionEventSeq)) ||
    (value.detail !== undefined && !isBoundedString(value.detail, MAX_DETAIL_LENGTH))) return undefined
  return {
    ...base,
    type: value.type,
    outcome: value.outcome,
    ...(value.sessionEventSeq === undefined ? {} : { sessionEventSeq: Number(value.sessionEventSeq) }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  }
}

function foldRunEvents(events: readonly AutomationRunEvent[]): {
  phase: AutomationRunPhase
  cancellationRequested: boolean
} | undefined {
  let phase: AutomationRunPhase = 'queued'
  let cancellationRequested = false
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.seq !== index + 1 || (index === 0) !== (event.type === 'queued')) return undefined
    if (index > 0 && Date.parse(event.at) < Date.parse(events[index - 1]!.at)) return undefined
    if (event.type === 'queued') continue
    if (phase === 'succeeded' || phase === 'failed' || phase === 'cancelled' ||
      phase === 'interrupted' || phase === 'ambiguous') return undefined
    if (event.type === 'dispatch') {
      if (phase !== 'queued' || cancellationRequested) return undefined
      phase = 'dispatching'
      continue
    }
    if (event.type === 'running') {
      if (phase !== 'dispatching') return undefined
      phase = 'running'
      continue
    }
    if (event.type === 'cancel-requested') {
      if (cancellationRequested) return undefined
      cancellationRequested = true
      continue
    }
    if (event.outcome === 'succeeded' && phase !== 'running') return undefined
    if ((event.outcome === 'interrupted' || event.outcome === 'ambiguous') && phase === 'queued') return undefined
    if (event.outcome === 'cancelled') cancellationRequested = true
    phase = event.outcome
  }
  return { phase, cancellationRequested }
}

export function parseAutomationRunSummary(value: unknown): AutomationRunSummary | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'automationId', 'retryOfRunId', 'payloadHash', 'payload', 'phase', 'cancellationRequested',
    'createdAt', 'updatedAt', 'events',
  ]) || !isUuid(value.id) || !isUuid(value.automationId) ||
    (value.retryOfRunId !== undefined && (!isUuid(value.retryOfRunId) || value.retryOfRunId === value.id)) ||
    typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash) ||
    (value.phase !== 'queued' && value.phase !== 'dispatching' && value.phase !== 'running' &&
      value.phase !== 'succeeded' && value.phase !== 'failed' && value.phase !== 'cancelled' &&
      value.phase !== 'interrupted' && value.phase !== 'ambiguous') ||
    typeof value.cancellationRequested !== 'boolean' || !isCanonicalIsoDate(value.createdAt) ||
    !isCanonicalIsoDate(value.updatedAt) || !Array.isArray(value.events) ||
    value.events.length === 0 || value.events.length > MAX_RUN_EVENTS) return undefined
  const payload = parseAutomationRunPayload(value.payload)
  const events = value.events.map(parseAutomationRunEvent)
  if (payload === undefined || events.some(event => event === undefined)) return undefined
  const exactEvents = events as AutomationRunEvent[]
  const folded = foldRunEvents(exactEvents)
  const runningEvent = exactEvents.find(event => event.type === 'running')
  const terminalEvent = exactEvents.find(event => event.type === 'terminal')
  if (folded === undefined || folded.phase !== value.phase ||
    folded.cancellationRequested !== value.cancellationRequested ||
    value.createdAt !== exactEvents[0]!.at || value.updatedAt !== exactEvents.at(-1)!.at ||
    (runningEvent?.type === 'running' && terminalEvent?.type === 'terminal' &&
      terminalEvent.sessionEventSeq !== undefined && terminalEvent.sessionEventSeq < runningEvent.sessionEventSeq)) {
    return undefined
  }
  return {
    id: value.id,
    automationId: value.automationId,
    ...(value.retryOfRunId === undefined ? {} : { retryOfRunId: value.retryOfRunId }),
    payloadHash: value.payloadHash,
    payload,
    phase: value.phase,
    cancellationRequested: value.cancellationRequested,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    events: exactEvents,
  }
}

export function parseAutomationSnapshot(value: unknown): AutomationSnapshot | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['revision', 'automations', 'runs']) ||
    !isNonNegativeSafeInteger(value.revision) || !Array.isArray(value.automations) ||
    value.automations.length > MAX_AUTOMATIONS || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) {
    return undefined
  }
  const automations = value.automations.map(parseAutomationDefinition)
  const runs = value.runs.map(parseAutomationRunSummary)
  if (automations.some(automation => automation === undefined) || runs.some(run => run === undefined)) return undefined
  const exactAutomations = automations as AutomationDefinition[]
  const exactRuns = runs as AutomationRunSummary[]
  const operationIds = exactRuns.flatMap(run => run.events.map(event => event.operationId))
  const sessionIds = exactRuns.map(run => run.payload.sessionId)
  const scheduledOccurrences = exactRuns.flatMap(run => run.payload.invocation.kind === 'scheduled'
    ? [`${run.automationId}\0${run.payload.invocation.occurrenceAt}`]
    : [])
  if (new Set(exactAutomations.map(automation => automation.id)).size !== exactAutomations.length ||
    new Set(exactRuns.map(run => run.id)).size !== exactRuns.length ||
    new Set(operationIds).size !== operationIds.length || new Set(sessionIds).size !== sessionIds.length ||
    new Set(scheduledOccurrences).size !== scheduledOccurrences.length) return undefined
  const byRunId = new Map(exactRuns.map(run => [run.id, run]))
  for (const run of exactRuns) {
    if (run.retryOfRunId === undefined) continue
    const prior = byRunId.get(run.retryOfRunId)
    if (prior === undefined || prior.automationId !== run.automationId ||
      prior.phase === 'queued' || prior.phase === 'dispatching' || prior.phase === 'running') return undefined
    const seen = new Set([run.id])
    let cursor: AutomationRunSummary | undefined = prior
    while (cursor !== undefined) {
      if (seen.has(cursor.id)) return undefined
      seen.add(cursor.id)
      cursor = cursor.retryOfRunId === undefined ? undefined : byRunId.get(cursor.retryOfRunId)
    }
  }
  return { revision: Number(value.revision), automations: exactAutomations, runs: exactRuns }
}

export function parseAutomationClaimNextParams(value: unknown): AutomationClaimNextParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['hostInstanceId']) || !isUuid(value.hostInstanceId)) {
    return undefined
  }
  return { hostInstanceId: value.hostInstanceId }
}

export function parseAutomationDispatchClaim(value: unknown): AutomationDispatchClaim | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['run', 'workspacePath', 'worktreeId']) ||
    !isBoundedString(value.workspacePath, MAX_PATH_LENGTH) ||
    (value.worktreeId !== undefined && !isUuid(value.worktreeId))) return undefined
  const run = parseAutomationRunSummary(value.run)
  const dispatch = run === undefined
    ? undefined
    : [...run.events].reverse().find(event => event.type === 'dispatch')
  if (run?.phase !== 'dispatching' || dispatch?.type !== 'dispatch' ||
    dispatch.workspacePath !== value.workspacePath || dispatch.worktreeId !== value.worktreeId) return undefined
  return {
    run,
    workspacePath: value.workspacePath,
    ...(value.worktreeId === undefined ? {} : { worktreeId: value.worktreeId }),
  }
}

export function parseAutomationClaimNextResult(value: unknown): AutomationClaimNextResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['dispatch'])) return undefined
  if (value.dispatch === undefined) return {}
  const dispatch = parseAutomationDispatchClaim(value.dispatch)
  return dispatch === undefined ? undefined : { dispatch }
}

export function parseAutomationInspectOwnedResult(value: unknown): AutomationInspectOwnedResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['run'])) return undefined
  if (value.run === undefined) return {}
  const run = parseAutomationRunSummary(value.run)
  return run === undefined || run.phase !== 'dispatching' && run.phase !== 'running'
    ? undefined
    : { run }
}

export function parseAutomationMarkRunningParams(value: unknown): AutomationMarkRunningParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['hostInstanceId', 'runId', 'sessionEventSeq']) ||
    !isUuid(value.hostInstanceId) || !isUuid(value.runId) ||
    !isNonNegativeSafeInteger(value.sessionEventSeq)) return undefined
  return {
    hostInstanceId: value.hostInstanceId,
    runId: value.runId,
    sessionEventSeq: Number(value.sessionEventSeq),
  }
}

export function parseAutomationFinishParams(value: unknown): AutomationFinishParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'hostInstanceId', 'runId', 'outcome', 'sessionEventSeq', 'detail',
  ]) || !isUuid(value.hostInstanceId) || !isUuid(value.runId) ||
    (value.outcome !== 'succeeded' && value.outcome !== 'failed' && value.outcome !== 'cancelled' &&
      value.outcome !== 'interrupted' && value.outcome !== 'ambiguous') ||
    (value.sessionEventSeq !== undefined && !isNonNegativeSafeInteger(value.sessionEventSeq)) ||
    (value.detail !== undefined && !isBoundedString(value.detail, MAX_DETAIL_LENGTH))) return undefined
  return {
    hostInstanceId: value.hostInstanceId,
    runId: value.runId,
    outcome: value.outcome,
    ...(value.sessionEventSeq === undefined ? {} : { sessionEventSeq: Number(value.sessionEventSeq) }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  }
}

function parseDesktopAutomationExecution(value: unknown): DesktopAutomationExecutionInput | undefined {
  if (!isRecord(value) || (value.mode !== 'worktree' && value.mode !== 'local')) return undefined
  if (value.mode === 'local') {
    return hasOnlyKeys(value, ['mode', 'localCheckoutAcknowledged']) &&
      value.localCheckoutAcknowledged === true
      ? { mode: value.mode, localCheckoutAcknowledged: true }
      : undefined
  }
  if (!hasOnlyKeys(value, ['mode', 'baseRef']) || !isBoundedString(value.baseRef, MAX_REF_LENGTH) ||
    /[\r\n]/.test(value.baseRef)) return undefined
  return { mode: value.mode, baseRef: value.baseRef }
}

export function parseDesktopCreateAutomationInput(value: unknown): DesktopCreateAutomationInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'operationId', 'requestedAt', 'name', 'prompt', 'projectPath', 'trigger', 'execution', 'concurrencyPolicy',
    'skillIds', 'connectionIds',
  ]) || !isUuid(value.operationId) || !isCanonicalIsoDate(value.requestedAt) ||
    !isBoundedString(value.name, MAX_NAME_LENGTH) || value.name.trim() !== value.name ||
    !isBoundedString(value.prompt, MAX_PROMPT_LENGTH) || value.prompt.trim() !== value.prompt ||
    !isBoundedString(value.projectPath, MAX_PATH_LENGTH)) return undefined
  const trigger = parseAutomationTrigger(value.trigger)
  const execution = parseDesktopAutomationExecution(value.execution)
  const concurrencyPolicy = parseConcurrencyPolicy(value.concurrencyPolicy)
  const skillIds = parseReferenceList(value.skillIds)
  const connectionIds = parseReferenceList(value.connectionIds)
  if (trigger === undefined || execution === undefined || concurrencyPolicy === undefined ||
    skillIds === undefined || connectionIds === undefined) return undefined
  return {
    operationId: value.operationId,
    requestedAt: value.requestedAt,
    name: value.name,
    prompt: value.prompt,
    projectPath: value.projectPath,
    trigger,
    execution,
    concurrencyPolicy,
    skillIds,
    connectionIds,
  }
}

export function parseDesktopSetAutomationStateInput(value: unknown): DesktopSetAutomationStateInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'operationId', 'requestedAt', 'automationId', 'expectedRevision', 'state',
  ]) || !isUuid(value.operationId) || !isCanonicalIsoDate(value.requestedAt) || !isUuid(value.automationId) ||
    !isPositiveSafeInteger(value.expectedRevision) ||
    (value.state !== 'enabled' && value.state !== 'paused')) return undefined
  return {
    operationId: value.operationId,
    requestedAt: value.requestedAt,
    automationId: value.automationId,
    expectedRevision: Number(value.expectedRevision),
    state: value.state,
  }
}

export function parseDesktopDeleteAutomationInput(value: unknown): DesktopDeleteAutomationInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'automationId', 'expectedRevision']) ||
    !isUuid(value.operationId) || !isUuid(value.automationId) ||
    !isPositiveSafeInteger(value.expectedRevision)) return undefined
  return {
    operationId: value.operationId,
    automationId: value.automationId,
    expectedRevision: Number(value.expectedRevision),
  }
}

export function parseDesktopQueueAutomationRunInput(value: unknown): DesktopQueueAutomationRunInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'automationId', 'retryOfRunId']) ||
    !isUuid(value.operationId) || !isUuid(value.automationId) ||
    (value.retryOfRunId !== undefined && !isUuid(value.retryOfRunId))) return undefined
  return {
    operationId: value.operationId,
    automationId: value.automationId,
    ...(value.retryOfRunId === undefined ? {} : { retryOfRunId: value.retryOfRunId }),
  }
}

export function parseDesktopCancelAutomationRunInput(value: unknown): DesktopCancelAutomationRunInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'runId']) ||
    !isUuid(value.operationId) || !isUuid(value.runId)) return undefined
  return { operationId: value.operationId, runId: value.runId }
}

export function parseDesktopOpenAutomationSessionInput(value: unknown): DesktopOpenAutomationSessionInput | undefined {
  return isRecord(value) && hasOnlyKeys(value, ['sessionId']) && isUuid(value.sessionId)
    ? { sessionId: value.sessionId }
    : undefined
}

export function parseDesktopListAutomationRunsInput(value: unknown): DesktopListAutomationRunsInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['expectedRevision', 'beforeRunId', 'limit']) ||
    !isNonNegativeSafeInteger(value.expectedRevision) || !isUuid(value.beforeRunId) ||
    !isPositiveSafeInteger(value.limit) || value.limit > MAX_TASK_CENTER_RECENT_RUNS) return undefined
  return {
    expectedRevision: Number(value.expectedRevision),
    beforeRunId: value.beforeRunId,
    limit: Number(value.limit),
  }
}

function hasValidTaskCenterRunList(runs: readonly AutomationRunSummary[]): boolean {
  const operationIds = runs.flatMap(run => run.events.map(event => event.operationId))
  if (new Set(runs.map(item => item.id)).size !== runs.length ||
    new Set(runs.map(item => item.payload.sessionId)).size !== runs.length ||
    new Set(operationIds).size !== operationIds.length) return false
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]!
    const current = runs[index]!
    if (Date.parse(previous.updatedAt) < Date.parse(current.updatedAt) ||
      (previous.updatedAt === current.updatedAt && previous.id.localeCompare(current.id) < 0)) return false
  }
  return true
}

export function parseAutomationTaskCenterSnapshot(value: unknown): AutomationTaskCenterSnapshot | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'revision', 'automations', 'recentRuns', 'totalRunCount', 'executionAvailability',
  ]) || !isNonNegativeSafeInteger(value.revision) || !Array.isArray(value.automations) ||
    value.automations.length > MAX_AUTOMATIONS || !Array.isArray(value.recentRuns) ||
    value.recentRuns.length > MAX_TASK_CENTER_RECENT_RUNS ||
    !isNonNegativeSafeInteger(value.totalRunCount) || value.totalRunCount > MAX_RUNS ||
    value.totalRunCount < value.recentRuns.length ||
    value.executionAvailability !== 'requires-app-running') return undefined
  const automations = value.automations.map(parseAutomationDefinition)
  const recentRuns = value.recentRuns.map(parseAutomationRunSummary)
  if (automations.some(item => item === undefined) || recentRuns.some(item => item === undefined)) return undefined
  const exactAutomations = automations as AutomationDefinition[]
  const exactRuns = recentRuns as AutomationRunSummary[]
  if (new Set(exactAutomations.map(item => item.id)).size !== exactAutomations.length ||
    !hasValidTaskCenterRunList(exactRuns)) return undefined
  return {
    revision: Number(value.revision),
    automations: exactAutomations,
    recentRuns: exactRuns,
    totalRunCount: Number(value.totalRunCount),
    executionAvailability: value.executionAvailability,
  }
}

export function parseAutomationRunPage(value: unknown): AutomationRunPage | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'revision', 'runs', 'totalRunCount', 'nextBeforeRunId',
  ]) || !isNonNegativeSafeInteger(value.revision) || !Array.isArray(value.runs) ||
    value.runs.length > MAX_TASK_CENTER_RECENT_RUNS || !isNonNegativeSafeInteger(value.totalRunCount) ||
    value.totalRunCount > MAX_RUNS || value.totalRunCount < value.runs.length ||
    (value.nextBeforeRunId !== undefined && !isUuid(value.nextBeforeRunId))) return undefined
  const runs = value.runs.map(parseAutomationRunSummary)
  if (runs.some(item => item === undefined)) return undefined
  const exactRuns = runs as AutomationRunSummary[]
  if (!hasValidTaskCenterRunList(exactRuns) ||
    (value.nextBeforeRunId !== undefined && exactRuns.at(-1)?.id !== value.nextBeforeRunId)) return undefined
  return {
    revision: Number(value.revision),
    runs: exactRuns,
    totalRunCount: Number(value.totalRunCount),
    ...(value.nextBeforeRunId === undefined ? {} : { nextBeforeRunId: value.nextBeforeRunId }),
  }
}

export function parseAutomationChangedNotice(value: unknown): AutomationChangedNotice | undefined {
  return isRecord(value) && hasOnlyKeys(value, ['revision']) && isNonNegativeSafeInteger(value.revision)
    ? { revision: Number(value.revision) }
    : undefined
}
