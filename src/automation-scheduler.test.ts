import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { TestContext } from 'node:test'

import type { AutomationDefinitionDraft } from './automation-registry'
import { AutomationRegistry, AutomationRegistryError } from './automation-registry'
import { AutomationScheduler } from './automation-scheduler'

function definition(overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    name: 'Daily review',
    prompt: 'Review the repository and summarize actionable changes.',
    projectPath: '/repo',
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
    concurrencyPolicy: 'skip',
    skillIds: [],
    connectionIds: [],
    state: 'enabled',
    nextTriggerAt: '2026-08-14T01:00:00.000Z',
    ...overrides,
  }
}

async function fixture(t: TestContext, initialNow = '2026-08-16T03:00:00.000Z') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-scheduler-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse(initialNow)
  const registry = new AutomationRegistry(join(root, 'automations.v1.json'), {
    now: () => new Date(now),
  })
  return {
    root,
    registry,
    now: () => new Date(now),
    setNow: (value: string) => { now = Date.parse(value) },
  }
}

test('admits only the latest missed occurrence and remains duplicate-free after restart', async t => {
  const context = await fixture(t)
  const created = context.registry.createDefinition({ operationId: 'create-missed', definition: definition() })
  const scheduler = new AutomationScheduler(context.registry, { now: context.now })

  const evaluation = scheduler.evaluateDue()
  assert.equal(evaluation.admissions.length, 1)
  assert.equal(evaluation.admissions[0]?.occurrenceAt, '2026-08-16T01:00:00.000Z')
  assert.equal(evaluation.admissions[0]?.decision, 'queued')
  assert.equal(evaluation.admissions[0]?.run?.payload.invocation.kind, 'scheduled')
  assert.equal(context.registry.getDefinition(created.automationId)?.lastTriggeredAt, '2026-08-16T01:00:00.000Z')
  assert.equal(context.registry.getDefinition(created.automationId)?.nextTriggerAt, '2026-08-17T01:00:00.000Z')
  assert.equal(scheduler.evaluateDue().admissions.length, 0)

  const restored = new AutomationRegistry(join(context.root, 'automations.v1.json'), { now: context.now })
  assert.equal(new AutomationScheduler(restored, { now: context.now }).evaluateDue().admissions.length, 0)
  assert.equal(restored.snapshot().runs.length, 1)
})

test('persists a skip decision and advances cadence without inventing a run', async t => {
  const context = await fixture(t, '2026-08-17T02:00:00.000Z')
  const created = context.registry.createDefinition({
    operationId: 'create-skip',
    definition: definition({ nextTriggerAt: '2026-08-17T01:00:00.000Z', concurrencyPolicy: 'skip' }),
  })
  context.registry.queueRun({
    operationId: 'foreground-queued',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })

  const admission = new AutomationScheduler(context.registry, { now: context.now }).evaluateDue().admissions[0]!
  assert.equal(admission.decision, 'skipped')
  assert.equal(admission.run, undefined)
  assert.equal(context.registry.snapshot().runs.length, 1)
  assert.equal(context.registry.getDefinition(created.automationId)?.lastTriggeredAt, '2026-08-17T01:00:00.000Z')
  assert.equal(context.registry.getDefinition(created.automationId)?.nextTriggerAt, '2026-08-18T01:00:00.000Z')
  assert.equal(new AutomationRegistry(join(context.root, 'automations.v1.json')).status().available, true)
})

test('queue-one admits one deferred run and claim serialization prevents overlap', async t => {
  const context = await fixture(t, '2026-08-17T02:00:00.000Z')
  const created = context.registry.createDefinition({
    operationId: 'create-queue-one',
    definition: definition({
      nextTriggerAt: '2026-08-17T01:00:00.000Z',
      concurrencyPolicy: 'queue-one',
    }),
  })
  const active = context.registry.queueRun({
    operationId: 'queue-active',
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
  context.registry.claimRun({
    operationId: 'claim-active',
    runId: active.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/active',
  })
  context.registry.markRunRunning({ operationId: 'running-active', runId: active.id, sessionEventSeq: 1 })

  const scheduler = new AutomationScheduler(context.registry, { now: context.now })
  const first = scheduler.evaluateDue().admissions[0]!
  assert.equal(first.decision, 'queued')
  const deferred = first.run!
  assert.throws(() => context.registry.claimRun({
    operationId: 'claim-too-early',
    runId: deferred.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/deferred',
  }), (error: AutomationRegistryError) => error.code === 'CONFLICT')

  context.setNow('2026-08-18T02:00:00.000Z')
  const second = scheduler.evaluateDue().admissions[0]!
  assert.equal(second.decision, 'skipped')
  assert.equal(context.registry.snapshot().runs.length, 2)

  context.registry.finishRun({
    operationId: 'finish-active',
    runId: active.id,
    outcome: 'succeeded',
    sessionEventSeq: 2,
  })
  assert.equal(context.registry.claimRun({
    operationId: 'claim-deferred',
    runId: deferred.id,
    hostInstanceId: 'host-1',
    workspacePath: '/managed/deferred',
  }).phase, 'dispatching')
})

test('completes a due one-shot definition in the same commit as its run', async t => {
  const context = await fixture(t, '2026-08-17T02:00:00.000Z')
  const at = '2026-08-17T01:00:00.000Z'
  const created = context.registry.createDefinition({
    operationId: 'create-once',
    definition: definition({
      trigger: { kind: 'once', at },
      nextTriggerAt: at,
    }),
  })
  const admission = new AutomationScheduler(context.registry, { now: context.now }).evaluateDue().admissions[0]!
  assert.equal(admission.decision, 'queued')
  assert.equal(admission.state, 'completed')
  assert.equal(context.registry.getDefinition(created.automationId)?.state, 'completed')
  assert.equal(context.registry.getDefinition(created.automationId)?.nextTriggerAt, undefined)
  assert.equal(context.registry.getDefinition(created.automationId)?.lastTriggeredAt, at)
})

test('uses one bounded timer owner and keeps wakeup delivery best effort', async t => {
  const context = await fixture(t, '2026-08-17T00:59:00.000Z')
  context.registry.createDefinition({
    operationId: 'create-timer',
    definition: definition({ nextTriggerAt: '2026-08-17T01:00:00.000Z' }),
  })
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  let timerId = 0
  let wakeups = 0
  const scheduler = new AutomationScheduler(context.registry, {
    now: context.now,
    setTimer: (callback, delayMs) => {
      const id = ++timerId
      timers.set(id, {
        callback: () => {
          timers.delete(id)
          callback()
        },
        delayMs,
      })
      return id
    },
    clearTimer: handle => timers.delete(handle as number),
    onAdmissions: () => {
      wakeups += 1
      throw new Error('simulated disconnected Host wakeup')
    },
  })

  scheduler.start()
  assert.equal(scheduler.status().nextWakeAt, '2026-08-17T01:00:00.000Z')
  assert.equal(timers.get(1)?.delayMs, 60_000)
  scheduler.refresh()
  assert.equal(timers.has(1), false)
  assert.equal(timers.get(2)?.delayMs, 60_000)
  context.setNow('2026-08-17T01:00:00.000Z')
  timers.get(2)!.callback()
  assert.equal(wakeups, 1)
  assert.equal(context.registry.snapshot().runs.length, 1)
  assert.equal(scheduler.status().lastError, undefined)
  assert.equal(timers.size, 1)
  scheduler.stop()
  assert.equal(timers.size, 0)
})

test('rejects semantically invalid trigger timestamps before persistence', async t => {
  const context = await fixture(t)
  assert.throws(() => context.registry.createDefinition({
    operationId: 'create-invalid-cron',
    definition: definition({
      trigger: { kind: 'cron', expression: 'not a cron * *', timeZone: 'UTC' },
    }),
  }), (error: AutomationRegistryError) => error.code === 'BAD_MESSAGE')
  assert.throws(() => context.registry.createDefinition({
    operationId: 'create-invalid-occurrence',
    definition: definition({ nextTriggerAt: '2026-08-14T01:01:00.000Z' }),
  }), (error: AutomationRegistryError) => error.code === 'BAD_MESSAGE')
  assert.equal(context.registry.status().revision, 0)
})

test('stops the timer owner when durable authority is unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-scheduler-corrupt-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'automations.v1.json')
  await writeFile(path, '{not json')
  const errors: string[] = []
  const scheduler = new AutomationScheduler(new AutomationRegistry(path), {
    onError: error => errors.push(error.message),
  })

  scheduler.start()
  assert.equal(scheduler.status().running, false)
  assert.match(scheduler.status().lastError ?? '', /could not be loaded safely/)
  assert.equal(errors.length, 1)
})
