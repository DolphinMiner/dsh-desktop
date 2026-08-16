import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseAutomationClaimNextParams,
  parseAutomationClaimNextResult,
  parseAutomationDefinition,
  parseAutomationFinishParams,
  parseAutomationMarkRunningParams,
  parseAutomationRunSummary,
  parseAutomationSnapshot,
  parseAutomationTrigger,
} from './automation.js'

const automationId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const sessionId = '33333333-3333-4333-8333-333333333333'
const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }

const definition = {
  id: automationId,
  revision: 1,
  name: 'Daily review',
  prompt: 'Review the current repository and summarize actionable changes.',
  projectPath: '/repo',
  repository,
  trigger: { kind: 'cron' as const, expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' },
  execution: { mode: 'worktree' as const, baseRef: 'refs/heads/main' },
  concurrencyPolicy: 'skip' as const,
  skillIds: ['review'],
  connectionIds: ['linear-primary'],
  state: 'enabled' as const,
  nextTriggerAt: '2026-08-17T01:00:00.000Z',
  createdAt: '2026-08-16T08:00:00.000Z',
  updatedAt: '2026-08-16T08:00:00.000Z',
}

const payload = {
  definitionRevision: 1,
  definitionName: definition.name,
  prompt: definition.prompt,
  projectPath: definition.projectPath,
  repository,
  trigger: definition.trigger,
  execution: definition.execution,
  concurrencyPolicy: definition.concurrencyPolicy,
  skillIds: definition.skillIds,
  connectionIds: definition.connectionIds,
  invocation: { kind: 'scheduled' as const, occurrenceAt: definition.nextTriggerAt },
  sessionId,
}

function queuedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    automationId,
    payloadHash: 'a'.repeat(64),
    payload,
    phase: 'queued' as const,
    cancellationRequested: false,
    createdAt: '2026-08-17T01:00:00.000Z',
    updatedAt: '2026-08-17T01:00:00.000Z',
    events: [{
      seq: 1,
      operationId: 'queue-run-1',
      at: '2026-08-17T01:00:00.000Z',
      type: 'queued' as const,
    }],
    ...overrides,
  }
}

test('validates one-shot and five-field zoned automation triggers', () => {
  assert.deepEqual(parseAutomationTrigger({
    kind: 'once',
    at: '2026-08-17T01:00:00.000Z',
  }), { kind: 'once', at: '2026-08-17T01:00:00.000Z' })
  assert.deepEqual(parseAutomationTrigger(definition.trigger), definition.trigger)
  assert.equal(parseAutomationTrigger({
    kind: 'cron',
    expression: '0 9 * *',
    timeZone: 'Asia/Shanghai',
  }), undefined)
  assert.equal(parseAutomationTrigger({
    kind: 'cron',
    expression: '0 9 * * *',
    timeZone: 'local',
  }), undefined)
  assert.equal(parseAutomationTrigger({
    kind: 'once',
    at: '2026-08-17T01:00:00Z',
  }), undefined)
})

test('binds an enabled definition to one computed next trigger', () => {
  assert.deepEqual(parseAutomationDefinition(definition), definition)
  assert.equal(parseAutomationDefinition({ ...definition, nextTriggerAt: undefined }), undefined)
  assert.equal(parseAutomationDefinition({
    ...definition,
    state: 'paused',
  }), undefined)
  assert.equal(parseAutomationDefinition({
    ...definition,
    state: 'completed',
    nextTriggerAt: undefined,
  }), undefined)
  assert.equal(parseAutomationDefinition({
    ...definition,
    repository: { ...repository, extra: true },
  }), undefined)
  assert.equal(parseAutomationDefinition({
    ...definition,
    skillIds: ['review', 'review'],
  }), undefined)
})

test('derives run phase only from a contiguous append-only event chain', () => {
  const queued = queuedRun()
  assert.deepEqual(parseAutomationRunSummary(queued), queued)
  const running = {
    ...queued,
    phase: 'running' as const,
    updatedAt: '2026-08-17T01:00:02.000Z',
    events: [
      ...queued.events,
      {
        seq: 2,
        operationId: 'dispatch-run-1',
        at: '2026-08-17T01:00:01.000Z',
        type: 'dispatch' as const,
        hostInstanceId: 'host-1',
        workspacePath: '/managed/run-1',
        worktreeId: '44444444-4444-4444-8444-444444444444',
      },
      {
        seq: 3,
        operationId: 'start-run-1',
        at: '2026-08-17T01:00:02.000Z',
        type: 'running' as const,
        sessionEventSeq: 1,
      },
    ],
  }
  assert.deepEqual(parseAutomationRunSummary(running), running)
  const succeeded = {
    ...running,
    phase: 'succeeded' as const,
    updatedAt: '2026-08-17T01:05:00.000Z',
    events: [...running.events, {
      seq: 4,
      operationId: 'finish-run-1',
      at: '2026-08-17T01:05:00.000Z',
      type: 'terminal' as const,
      outcome: 'succeeded' as const,
      sessionEventSeq: 22,
    }],
  }
  assert.deepEqual(parseAutomationRunSummary(succeeded), succeeded)
  assert.equal(parseAutomationRunSummary({ ...succeeded, phase: 'failed' }), undefined)
  assert.equal(parseAutomationRunSummary({
    ...succeeded,
    events: [...succeeded.events, {
      seq: 5,
      operationId: 'overwrite-terminal',
      at: '2026-08-17T01:06:00.000Z',
      type: 'terminal',
      outcome: 'failed',
    }],
    updatedAt: '2026-08-17T01:06:00.000Z',
  }), undefined)
  assert.equal(parseAutomationRunSummary({
    ...running,
    events: running.events.map((event, index) => index === 2 ? { ...event, seq: 4 } : event),
  }), undefined)
})

test('allows one cancellation request without changing the authoritative run phase', () => {
  const queued = queuedRun()
  const requested = {
    ...queued,
    cancellationRequested: true,
    updatedAt: '2026-08-17T01:00:01.000Z',
    events: [...queued.events, {
      seq: 2,
      operationId: 'cancel-request-1',
      at: '2026-08-17T01:00:01.000Z',
      type: 'cancel-requested' as const,
      reason: 'User cancelled from Task Center.',
    }],
  }
  assert.deepEqual(parseAutomationRunSummary(requested), requested)
  assert.equal(parseAutomationRunSummary({
    ...requested,
    updatedAt: '2026-08-17T01:00:02.000Z',
    events: [...requested.events, {
      seq: 3,
      operationId: 'cancel-request-2',
      at: '2026-08-17T01:00:02.000Z',
      type: 'cancel-requested',
    }],
  }), undefined)
})

test('binds Host automation claims and lifecycle evidence to exact run state', () => {
  const hostInstanceId = '77777777-7777-4777-8777-777777777777'
  const worktreeId = '44444444-4444-4444-8444-444444444444'
  const queued = queuedRun()
  const dispatching = {
    ...queued,
    phase: 'dispatching' as const,
    updatedAt: '2026-08-17T01:00:01.000Z',
    events: [...queued.events, {
      seq: 2,
      operationId: 'dispatch-run-1',
      at: '2026-08-17T01:00:01.000Z',
      type: 'dispatch' as const,
      hostInstanceId,
      workspacePath: '/managed/run-1',
      worktreeId,
    }],
  }
  assert.deepEqual(parseAutomationClaimNextParams({ hostInstanceId }), { hostInstanceId })
  assert.equal(parseAutomationClaimNextParams({ hostInstanceId: 'host-1' }), undefined)
  assert.deepEqual(parseAutomationClaimNextResult({ dispatch: {
    run: dispatching,
    workspacePath: '/managed/run-1',
    worktreeId,
  } }), {
    dispatch: { run: dispatching, workspacePath: '/managed/run-1', worktreeId },
  })
  assert.deepEqual(parseAutomationClaimNextResult({}), {})
  assert.equal(parseAutomationClaimNextResult({ dispatch: {
    run: dispatching,
    workspacePath: '/different-path',
    worktreeId,
  } }), undefined)
  assert.deepEqual(parseAutomationMarkRunningParams({
    hostInstanceId,
    runId,
    sessionEventSeq: 2,
  }), { hostInstanceId, runId, sessionEventSeq: 2 })
  assert.equal(parseAutomationMarkRunningParams({ hostInstanceId, runId, sessionEventSeq: -1 }), undefined)
  assert.deepEqual(parseAutomationFinishParams({
    hostInstanceId,
    runId,
    outcome: 'failed',
    sessionEventSeq: 8,
    detail: 'The Agent turn failed.',
  }), {
    hostInstanceId,
    runId,
    outcome: 'failed',
    sessionEventSeq: 8,
    detail: 'The Agent turn failed.',
  })
  assert.equal(parseAutomationFinishParams({ hostInstanceId, runId, outcome: 'unknown' }), undefined)
})

test('rejects duplicate occurrence, session, operation, and retry identities in a snapshot', () => {
  const first = queuedRun()
  const retry = queuedRun({
    id: '55555555-5555-4555-8555-555555555555',
    retryOfRunId: first.id,
    payload: {
      ...payload,
      invocation: { kind: 'manual', requestedAt: '2026-08-17T02:00:00.000Z' },
      sessionId: '66666666-6666-4666-8666-666666666666',
    },
    createdAt: '2026-08-17T02:00:00.000Z',
    updatedAt: '2026-08-17T02:00:00.000Z',
    events: [{
      seq: 1,
      operationId: 'queue-run-2',
      at: '2026-08-17T02:00:00.000Z',
      type: 'queued',
    }],
  })
  const terminalFirst = {
    ...first,
    phase: 'failed',
    updatedAt: '2026-08-17T01:00:01.000Z',
    events: [...first.events, {
      seq: 2,
      operationId: 'finish-run-1',
      at: '2026-08-17T01:00:01.000Z',
      type: 'terminal',
      outcome: 'failed',
    }],
  }
  assert.ok(parseAutomationSnapshot({ revision: 2, automations: [definition], runs: [terminalFirst, retry] }))
  assert.equal(parseAutomationSnapshot({ revision: 2, automations: [definition], runs: [first, retry] }), undefined)
  assert.equal(parseAutomationSnapshot({
    revision: 2,
    automations: [definition],
    runs: [first, { ...retry, retryOfRunId: undefined, payload: payload }],
  }), undefined)
  assert.equal(parseAutomationSnapshot({
    revision: 2,
    automations: [definition],
    runs: [first, {
      ...retry,
      retryOfRunId: undefined,
      payload: { ...retry.payload, sessionId },
    }],
  }), undefined)
  assert.equal(parseAutomationSnapshot({
    revision: 2,
    automations: [definition],
    runs: [first, {
      ...retry,
      retryOfRunId: undefined,
      events: [{ ...retry.events[0], operationId: first.events[0].operationId }],
    }],
  }), undefined)
})
