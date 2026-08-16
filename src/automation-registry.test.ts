import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import type { AutomationDefinitionDraft } from './automation-registry'
import {
  AutomationRegistry,
  AutomationRegistryError,
  hashAutomationRunPayload,
} from './automation-registry'

const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }

function definition(overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    name: 'Daily review',
    prompt: 'Review the repository and summarize actionable changes.',
    projectPath: '/repo',
    repository,
    trigger: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' },
    execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
    concurrencyPolicy: 'skip',
    skillIds: ['review'],
    connectionIds: ['linear-primary'],
    state: 'enabled',
    nextTriggerAt: '2026-08-17T01:00:00.000Z',
    ...overrides,
  }
}

async function temporaryRegistry(t: TestContext): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-registry-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'automations.v1.json') }
}

test('persists revisioned definitions, state changes, and a deletion tombstone', async t => {
  const { path } = await temporaryRegistry(t)
  let tick = 0
  const registry = new AutomationRegistry(path, {
    now: () => new Date(Date.UTC(2026, 7, 16, 8, 0, tick++)),
  })

  const created = registry.createDefinition({ operationId: 'create-1', definition: definition() })
  assert.equal(created.revision, 1)
  assert.equal(created.state, 'enabled')
  assert.equal(created.duplicate, false)
  assert.equal(registry.createDefinition({ operationId: 'create-1', definition: definition() }).duplicate, true)
  assert.equal(registry.status().revision, 1)
  assert.throws(() => registry.createDefinition({
    operationId: 'create-outside-repository',
    definition: definition({ projectPath: '/another-repository' }),
  }), (error: AutomationRegistryError) => error.code === 'BAD_MESSAGE')
  assert.equal(registry.status().revision, 1)

  const stored = registry.getDefinition(created.automationId)!
  stored.repository.root = '/mutated'
  stored.skillIds.push('mutated')
  assert.equal(registry.getDefinition(created.automationId)?.repository.root, '/repo')
  assert.deepEqual(registry.getDefinition(created.automationId)?.skillIds, ['review'])

  const paused = registry.setDefinitionState({
    operationId: 'pause-1',
    automationId: created.automationId,
    expectedRevision: 1,
    state: 'paused',
  })
  assert.deepEqual(paused, {
    automationId: created.automationId,
    revision: 2,
    state: 'paused',
    duplicate: false,
  })
  assert.equal(registry.getDefinition(created.automationId)?.nextTriggerAt, undefined)

  const resumed = registry.setDefinitionState({
    operationId: 'resume-1',
    automationId: created.automationId,
    expectedRevision: 2,
    state: 'enabled',
    nextTriggerAt: '2026-08-18T01:00:00.000Z',
  })
  const current = registry.getDefinition(created.automationId)!
  const replaced = registry.replaceDefinition({
    operationId: 'replace-1',
    automationId: created.automationId,
    expectedRevision: resumed.revision,
    definition: { ...definition(), name: 'Weekday review', nextTriggerAt: current.nextTriggerAt },
  })
  assert.equal(replaced.revision, 4)
  assert.equal(registry.getDefinition(created.automationId)?.name, 'Weekday review')
  assert.throws(() => registry.replaceDefinition({
    operationId: 'replace-stale',
    automationId: created.automationId,
    expectedRevision: 2,
    definition: definition(),
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')

  const historicalRun = registry.queueRun({
    operationId: 'queue-before-delete',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  registry.finishRun({
    operationId: 'fail-before-delete',
    runId: historicalRun.id,
    outcome: 'failed',
    detail: 'Preserved history.',
  })

  const deleted = registry.deleteDefinition({
    operationId: 'delete-1',
    automationId: created.automationId,
    expectedRevision: 4,
  })
  assert.equal(deleted.revision, 5)
  assert.equal(deleted.state, 'deleted')
  assert.equal(registry.getDefinition(created.automationId), undefined)
  assert.deepEqual(registry.snapshot().automations, [])
  assert.equal(registry.snapshot().runs[0]?.id, historicalRun.id)

  const restored = new AutomationRegistry(path)
  assert.equal(restored.status().available, true)
  assert.equal(restored.getDefinition(created.automationId), undefined)
  assert.equal(restored.getRun(historicalRun.id)?.phase, 'failed')
  assert.equal(restored.deleteDefinition({
    operationId: 'delete-1',
    automationId: created.automationId,
    expectedRevision: 4,
  }).duplicate, true)
  assert.throws(() => restored.createDefinition({
    operationId: 'create-1',
    definition: definition({ name: 'Different request' }),
  }), (error: AutomationRegistryError) => error.code === 'DUPLICATE_REQUEST')

  const document = JSON.parse(await readFile(path, 'utf8')) as {
    records: Array<Record<string, unknown>>
  }
  assert.deepEqual(Object.keys(document.records[0]!).sort(), [
    'createdAt', 'deletedAt', 'id', 'revision', 'status',
  ])
  assert.equal(JSON.stringify(document.records).includes('Review the repository'), false)
})

test('snapshots immutable run payloads and verifies their hash after restart', async t => {
  const { path } = await temporaryRegistry(t)
  const registry = new AutomationRegistry(path)
  const source = definition()
  const created = registry.createDefinition({ operationId: 'create-payload', definition: source })
  const first = registry.queueRun({
    operationId: 'queue-manual-1',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  assert.equal(first.payload.definitionRevision, 1)
  assert.equal(first.payloadHash, hashAutomationRunPayload(first.payload))

  source.prompt = 'Mutated caller object'
  first.payload.prompt = 'Mutated returned object'
  assert.equal(registry.getRun(first.id)?.payload.prompt, definition().prompt)

  const current = registry.getDefinition(created.automationId)!
  registry.replaceDefinition({
    operationId: 'replace-payload',
    automationId: created.automationId,
    expectedRevision: current.revision,
    definition: { ...definition(), prompt: 'A newer reviewed prompt.' },
  })
  const second = registry.queueRun({
    operationId: 'queue-manual-2',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  assert.equal(second.payload.definitionRevision, 2)
  assert.equal(second.payload.prompt, 'A newer reviewed prompt.')
  assert.equal(registry.getRun(first.id)?.payload.definitionRevision, 1)

  const restored = new AutomationRegistry(path)
  assert.equal(restored.status().available, true)
  assert.equal(restored.queueRun({
    operationId: 'queue-manual-1',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  }).id, first.id)

  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    runs: Array<{ payload: { prompt: string } }>
  }
  raw.runs[0]!.payload.prompt = 'Tampered durable payload'
  await writeFile(path, JSON.stringify(raw))
  const corrupt = new AutomationRegistry(path)
  assert.equal(corrupt.status().available, false)
  assert.throws(() => corrupt.snapshot(),
    (error: AutomationRegistryError) => error.code === 'DESKTOP_UNAVAILABLE')
})

test('deduplicates scheduled occurrences and permits only terminal retries', async t => {
  const { path } = await temporaryRegistry(t)
  const registry = new AutomationRegistry(path, {
    now: () => new Date('2026-08-17T02:00:00.000Z'),
  })
  const created = registry.createDefinition({ operationId: 'create-scheduled', definition: definition() })
  const admission = registry.admitScheduledRun({
    operationId: 'queue-scheduled-1',
    automationId: created.automationId,
    expectedRevision: 1,
    expectedNextTriggerAt: '2026-08-17T01:00:00.000Z',
    occurrenceAt: '2026-08-17T01:00:00.000Z',
    nextTriggerAt: '2026-08-18T01:00:00.000Z',
  })
  const scheduled = admission.run!
  assert.equal(admission.decision, 'queued')
  assert.equal(admission.revision, 2)
  assert.equal(registry.getDefinition(created.automationId)?.nextTriggerAt, '2026-08-18T01:00:00.000Z')
  assert.equal(registry.admitScheduledRun({
    operationId: 'queue-scheduled-1',
    automationId: created.automationId,
    expectedRevision: 1,
    expectedNextTriggerAt: '2026-08-17T01:00:00.000Z',
    occurrenceAt: '2026-08-17T01:00:00.000Z',
    nextTriggerAt: '2026-08-18T01:00:00.000Z',
  }).run?.id, scheduled.id)
  assert.throws(() => registry.admitScheduledRun({
    operationId: 'queue-scheduled-duplicate-delivery',
    automationId: created.automationId,
    expectedRevision: 1,
    expectedNextTriggerAt: '2026-08-17T01:00:00.000Z',
    occurrenceAt: '2026-08-17T01:00:00.000Z',
    nextTriggerAt: '2026-08-18T01:00:00.000Z',
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')
  assert.equal(registry.snapshot().runs.length, 1)
  assert.throws(() => registry.admitScheduledRun({
    operationId: 'queue-stale-occurrence',
    automationId: created.automationId,
    expectedRevision: 2,
    expectedNextTriggerAt: '2026-08-18T01:00:00.000Z',
    occurrenceAt: '2026-08-18T01:00:00.000Z',
    nextTriggerAt: '2026-08-19T01:00:00.000Z',
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')

  const paused = registry.createDefinition({
    operationId: 'create-paused-scheduled',
    definition: definition({ state: 'paused', nextTriggerAt: undefined }),
  })
  assert.throws(() => registry.admitScheduledRun({
    operationId: 'queue-paused-occurrence',
    automationId: paused.automationId,
    expectedRevision: 1,
    expectedNextTriggerAt: '2026-08-17T01:00:00.000Z',
    occurrenceAt: '2026-08-17T01:00:00.000Z',
    nextTriggerAt: '2026-08-18T01:00:00.000Z',
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')
  assert.throws(() => registry.queueRun({
    operationId: 'retry-active',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
    retryOfRunId: scheduled.id,
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')

  const failed = registry.finishRun({
    operationId: 'fail-before-dispatch',
    runId: scheduled.id,
    outcome: 'failed',
    detail: 'Worktree provisioning failed before dispatch.',
  })
  assert.equal(failed.phase, 'failed')
  const retry = registry.queueRun({
    operationId: 'retry-terminal',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
    retryOfRunId: scheduled.id,
  })
  assert.equal(retry.retryOfRunId, scheduled.id)
  assert.notEqual(retry.payload.sessionId, scheduled.payload.sessionId)
  assert.equal(new AutomationRegistry(path).snapshot().runs.length, 2)
})

test('persists dispatch before Host work and never replays claimed or terminal runs on restart', async t => {
  const { path } = await temporaryRegistry(t)
  const registry = new AutomationRegistry(path)
  const created = registry.createDefinition({ operationId: 'create-dispatch', definition: definition() })
  const queued = registry.queueRun({
    operationId: 'queue-dispatch',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  const claimed = registry.claimRun({
    operationId: 'claim-dispatch',
    runId: queued.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/automation-run',
    worktreeId: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(claimed.phase, 'dispatching')
  const persistedAfterClaim = JSON.parse(await readFile(path, 'utf8')) as {
    runs: Array<{ phase: string }>
  }
  assert.equal(persistedAfterClaim.runs[0]?.phase, 'dispatching')

  const afterClaimRestart = new AutomationRegistry(path)
  assert.equal(afterClaimRestart.getRun(queued.id)?.phase, 'dispatching')
  assert.equal(afterClaimRestart.claimRun({
    operationId: 'claim-dispatch',
    runId: queued.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/automation-run',
    worktreeId: '11111111-1111-4111-8111-111111111111',
  }).phase, 'dispatching')
  const running = afterClaimRestart.markRunRunning({
    operationId: 'run-dispatch',
    runId: queued.id,
    sessionEventSeq: 10,
  })
  assert.equal(running.phase, 'running')
  const succeeded = afterClaimRestart.finishRun({
    operationId: 'finish-dispatch',
    runId: queued.id,
    outcome: 'succeeded',
    sessionEventSeq: 20,
  })
  assert.equal(succeeded.phase, 'succeeded')
  assert.equal(afterClaimRestart.markRunRunning({
    operationId: 'run-dispatch',
    runId: queued.id,
    sessionEventSeq: 10,
  }).phase, 'succeeded')
  assert.equal(afterClaimRestart.finishRun({
    operationId: 'finish-dispatch',
    runId: queued.id,
    outcome: 'succeeded',
    sessionEventSeq: 20,
  }).phase, 'succeeded')
  assert.throws(() => afterClaimRestart.finishRun({
    operationId: 'overwrite-terminal',
    runId: queued.id,
    outcome: 'failed',
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')
  assert.equal(new AutomationRegistry(path).getRun(queued.id)?.phase, 'succeeded')
})

test('cancels queued work locally and keeps claimed cancellation nonterminal until verified', async t => {
  const { path } = await temporaryRegistry(t)
  const registry = new AutomationRegistry(path)
  const created = registry.createDefinition({ operationId: 'create-cancel', definition: definition() })
  const queued = registry.queueRun({
    operationId: 'queue-cancel-local',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  const cancelled = registry.requestRunCancellation({
    operationId: 'cancel-local',
    runId: queued.id,
    reason: 'Cancelled before dispatch.',
  })
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(cancelled.cancellationRequested, true)
  assert.equal(registry.requestRunCancellation({
    operationId: 'cancel-local',
    runId: queued.id,
    reason: 'Cancelled before dispatch.',
  }).phase, 'cancelled')
  assert.throws(() => registry.claimRun({
    operationId: 'claim-cancelled',
    runId: queued.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/cancelled',
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')

  const claimedRun = registry.queueRun({
    operationId: 'queue-cancel-claimed',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  registry.claimRun({
    operationId: 'claim-cancel-claimed',
    runId: claimedRun.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/claimed',
  })
  const requested = registry.requestRunCancellation({
    operationId: 'cancel-claimed',
    runId: claimedRun.id,
  })
  assert.equal(requested.phase, 'dispatching')
  assert.equal(requested.cancellationRequested, true)
  assert.equal(new AutomationRegistry(path).getRun(claimedRun.id)?.phase, 'dispatching')
  assert.throws(() => registry.requestRunCancellation({
    operationId: 'cancel-claimed-again',
    runId: claimedRun.id,
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')
  const terminal = registry.finishRun({
    operationId: 'finish-cancel-claimed',
    runId: claimedRun.id,
    outcome: 'cancelled',
  })
  assert.equal(terminal.phase, 'cancelled')
  assert.equal(terminal.cancellationRequested, true)
})

test('rejects operation reuse across definitions and run transitions', async t => {
  const { path } = await temporaryRegistry(t)
  const registry = new AutomationRegistry(path)
  const created = registry.createDefinition({ operationId: 'shared-operation', definition: definition() })
  assert.throws(() => registry.queueRun({
    operationId: 'shared-operation',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  }), (error: AutomationRegistryError) => error.code === 'DUPLICATE_REQUEST')

  const run = registry.queueRun({
    operationId: 'queue-operation',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  assert.throws(() => registry.setDefinitionState({
    operationId: 'queue-operation',
    automationId: created.automationId,
    expectedRevision: 1,
    state: 'paused',
  }), (error: AutomationRegistryError) => error.code === 'DUPLICATE_REQUEST')
  registry.claimRun({
    operationId: 'claim-operation',
    runId: run.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/operation',
  })
  assert.throws(() => registry.claimRun({
    operationId: 'claim-operation',
    runId: run.id,
    hostInstanceId: 'host-2',
    workspacePath: '/managed/operation',
  }), (error: AutomationRegistryError) => error.code === 'DUPLICATE_REQUEST')
})

test('keeps timestamps monotonic when the wall clock moves backwards', async t => {
  const { path } = await temporaryRegistry(t)
  let now = Date.parse('2026-08-16T12:00:00.000Z')
  const registry = new AutomationRegistry(path, { now: () => new Date(now) })
  const created = registry.createDefinition({ operationId: 'create-clock', definition: definition() })
  const createdAt = registry.getDefinition(created.automationId)!.createdAt

  now -= 60_000
  registry.setDefinitionState({
    operationId: 'pause-clock',
    automationId: created.automationId,
    expectedRevision: 1,
    state: 'paused',
  })
  const paused = registry.getDefinition(created.automationId)!
  assert.ok(Date.parse(paused.updatedAt) >= Date.parse(createdAt))

  now -= 60_000
  const run = registry.queueRun({
    operationId: 'queue-clock',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  assert.ok(Date.parse(run.createdAt) >= Date.parse(paused.updatedAt))
  now -= 60_000
  const claimed = registry.claimRun({
    operationId: 'claim-clock',
    runId: run.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/clock',
  })
  assert.ok(Date.parse(claimed.updatedAt) >= Date.parse(run.updatedAt))
  assert.equal(new AutomationRegistry(path).status().available, true)
})

test('fails closed for corrupt state and for persistence before dispatch', async t => {
  const { root, path } = await temporaryRegistry(t)
  await writeFile(path, '{not json')
  const corrupt = new AutomationRegistry(path)
  assert.equal(corrupt.status().available, false)
  assert.throws(() => corrupt.snapshot(),
    (error: AutomationRegistryError) => error.code === 'DESKTOP_UNAVAILABLE')

  const data = join(root, 'data')
  const durableData = join(root, 'durable-data')
  const durablePath = join(data, 'automations.json')
  await mkdir(data)
  const registry = new AutomationRegistry(durablePath)
  const created = registry.createDefinition({ operationId: 'create-failure', definition: definition() })
  const run = registry.queueRun({
    operationId: 'queue-failure',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })

  await rename(data, durableData)
  await writeFile(data, 'blocks atomic persistence')
  assert.throws(() => registry.claimRun({
    operationId: 'claim-failure',
    runId: run.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/failure',
  }), (error: AutomationRegistryError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(registry.status().available, false)
  const durable = new AutomationRegistry(join(durableData, 'automations.json'))
  assert.equal(durable.getRun(run.id)?.phase, 'queued')

  const triggerData = join(root, 'trigger-data')
  const durableTriggerData = join(root, 'durable-trigger-data')
  const triggerPath = join(triggerData, 'automations.json')
  await mkdir(triggerData)
  const triggerRegistry = new AutomationRegistry(triggerPath, {
    now: () => new Date('2026-08-17T02:00:00.000Z'),
  })
  const triggerDefinition = triggerRegistry.createDefinition({
    operationId: 'create-trigger-failure',
    definition: definition(),
  })
  await rename(triggerData, durableTriggerData)
  await writeFile(triggerData, 'blocks trigger persistence')
  assert.throws(() => triggerRegistry.admitScheduledRun({
    operationId: 'admit-trigger-failure',
    automationId: triggerDefinition.automationId,
    expectedRevision: 1,
    expectedNextTriggerAt: '2026-08-17T01:00:00.000Z',
    occurrenceAt: '2026-08-17T01:00:00.000Z',
    nextTriggerAt: '2026-08-18T01:00:00.000Z',
  }), (error: AutomationRegistryError) => error.code === 'DESKTOP_UNAVAILABLE')
  const durableTrigger = new AutomationRegistry(join(durableTriggerData, 'automations.json'))
  assert.equal(durableTrigger.getDefinition(triggerDefinition.automationId)?.revision, 1)
  assert.equal(durableTrigger.snapshot().runs.length, 0)

  const unsupportedPath = join(root, 'unsupported.json')
  await writeFile(unsupportedPath, JSON.stringify({
    schemaVersion: 2,
    revision: 0,
    records: [],
    runs: [],
    definitionOperations: [],
  }))
  assert.equal(new AutomationRegistry(unsupportedPath).status().available, false)
})
