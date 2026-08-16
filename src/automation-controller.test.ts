import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { DesktopCreateAutomationInput } from '@dolphinminer/dsh-desktop-protocol'

import { AutomationController } from './automation-controller'
import { AutomationRegistry } from './automation-registry'

const CREATE_ID = '11111111-1111-4111-8111-111111111111'
const AUTOMATION_ID = '22222222-2222-4222-8222-222222222222'
const PAUSE_ID = '33333333-3333-4333-8333-333333333333'
const RESUME_ID = '44444444-4444-4444-8444-444444444444'
const RUN_ID = '55555555-5555-4555-8555-555555555555'
const CANCEL_ID = '66666666-6666-4666-8666-666666666666'

function createInput(overrides: Partial<DesktopCreateAutomationInput> = {}): DesktopCreateAutomationInput {
  return {
    operationId: CREATE_ID,
    requestedAt: '2026-08-16T00:30:00.000Z',
    name: 'Daily review',
    prompt: 'Review this repository and summarize actionable changes.',
    projectPath: '/selected/repo/subdir',
    trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
    concurrencyPolicy: 'skip',
    skillIds: [],
    connectionIds: [],
    ...overrides,
  }
}

test('creates definitions from authoritative Git identity and emits one durable change', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-controller-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let refreshes = 0
  let changes = 0
  let discoveries = 0
  const registry = new AutomationRegistry(join(root, 'automations.v1.json'), {
    now: () => new Date('2026-08-16T00:30:00.000Z'),
    randomId: () => AUTOMATION_ID,
  })
  const controller = new AutomationController(
    registry,
    { refresh: () => { refreshes += 1 } },
    {
      discoverRepository: async path => {
        discoveries += 1
        assert.equal(path, '/canonical/repo/subdir')
        return {
          root: '/canonical/repo',
          gitDir: '/canonical/repo/.git',
          commonDir: '/canonical/repo/.git',
        }
      },
    },
    {
      canonicalizeProjectPath: async () => '/canonical/repo/subdir',
      onChange: () => { changes += 1 },
    },
  )

  const created = await controller.create(createInput())
  assert.equal(created.executionAvailability, 'requires-app-running')
  assert.equal(created.automations[0]?.repository.root, '/canonical/repo')
  assert.equal(created.automations[0]?.projectPath, '/canonical/repo/subdir')
  assert.equal(created.automations[0]?.nextTriggerAt, '2026-08-16T01:00:00.000Z')
  assert.equal(refreshes, 1)
  assert.equal(changes, 1)

  await controller.create(createInput())
  assert.equal(discoveries, 2)
  assert.equal(refreshes, 1)
  assert.equal(changes, 1)
})

test('pauses, resumes, queues, cancels, and retains terminal history in Task Center', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-controller-state-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const generated = [AUTOMATION_ID, '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888']
  let refreshes = 0
  let changes = 0
  const registry = new AutomationRegistry(join(root, 'automations.v1.json'), {
    now: () => new Date('2026-08-16T00:30:00.000Z'),
    randomId: () => generated.shift()!,
  })
  const controller = new AutomationController(
    registry,
    { refresh: () => { refreshes += 1 } },
    { discoverRepository: async () => ({
      root: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
    }) },
    {
      canonicalizeProjectPath: async () => '/repo',
      onChange: () => { changes += 1 },
    },
  )
  await controller.create(createInput({ projectPath: '/repo' }))
  const paused = controller.setState({
    operationId: PAUSE_ID,
    requestedAt: '2026-08-16T00:30:00.000Z',
    automationId: AUTOMATION_ID,
    expectedRevision: 1,
    state: 'paused',
  })
  assert.equal(paused.automations[0]?.state, 'paused')
  const resumed = controller.setState({
    operationId: RESUME_ID,
    requestedAt: '2026-08-16T00:30:00.000Z',
    automationId: AUTOMATION_ID,
    expectedRevision: 2,
    state: 'enabled',
  })
  assert.equal(resumed.automations[0]?.nextTriggerAt, '2026-08-16T01:00:00.000Z')
  const duplicateResume = controller.setState({
    operationId: RESUME_ID,
    requestedAt: '2026-08-16T00:30:00.000Z',
    automationId: AUTOMATION_ID,
    expectedRevision: 2,
    state: 'enabled',
  })
  assert.equal(duplicateResume.automations[0]?.revision, 3)
  assert.equal(refreshes, 3)
  assert.equal(changes, 3)

  const queued = controller.queueRun({ operationId: RUN_ID, automationId: AUTOMATION_ID })
  const runId = queued.recentRuns[0]!.id
  assert.equal(queued.recentRuns[0]?.phase, 'queued')
  const cancelled = controller.cancelRun({ operationId: CANCEL_ID, runId })
  assert.equal(cancelled.recentRuns[0]?.phase, 'cancelled')
  assert.match(cancelled.recentRuns[0]?.events.at(-1)?.type ?? '', /terminal/)
  assert.equal(refreshes, 3)
  assert.equal(changes, 5)
})

test('fails closed when local execution is not explicitly acknowledged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-controller-local-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new AutomationRegistry(join(root, 'automations.v1.json'))
  const controller = new AutomationController(
    registry,
    { refresh: () => undefined },
    { discoverRepository: async () => ({ root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }) },
    { canonicalizeProjectPath: async () => '/repo' },
  )
  await assert.rejects(controller.create(createInput({
    projectPath: '/repo',
    execution: { mode: 'local', localCheckoutAcknowledged: false as true },
  })), /explicit acknowledgement/)
  assert.equal(registry.snapshot().automations.length, 0)
})

test('pages the complete durable run history against one exact registry revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-controller-page-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const generated = [
    AUTOMATION_ID,
    '71111111-1111-4111-8111-111111111111', '72111111-1111-4111-8111-111111111111',
    '73111111-1111-4111-8111-111111111111', '74111111-1111-4111-8111-111111111111',
    '75111111-1111-4111-8111-111111111111', '76111111-1111-4111-8111-111111111111',
    '77111111-1111-4111-8111-111111111111', '78111111-1111-4111-8111-111111111111',
    '79111111-1111-4111-8111-111111111111',
  ]
  let tick = 0
  const registry = new AutomationRegistry(join(root, 'automations.v1.json'), {
    now: () => new Date(Date.parse('2026-08-16T00:30:00.000Z') + tick++),
    randomId: () => generated.shift()!,
  })
  const controller = new AutomationController(
    registry,
    { refresh: () => undefined },
    { discoverRepository: async () => ({ root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }) },
    { canonicalizeProjectPath: async () => '/repo', recentRunLimit: 1 },
  )
  await controller.create(createInput({ projectPath: '/repo' }))
  controller.queueRun({
    operationId: '81111111-1111-4111-8111-111111111111',
    automationId: AUTOMATION_ID,
  })
  controller.queueRun({
    operationId: '82111111-1111-4111-8111-111111111111',
    automationId: AUTOMATION_ID,
  })
  controller.queueRun({
    operationId: '83111111-1111-4111-8111-111111111111',
    automationId: AUTOMATION_ID,
  })

  const first = controller.snapshot()
  assert.equal(first.recentRuns.length, 1)
  assert.equal(first.totalRunCount, 3)
  const second = controller.listRuns({
    expectedRevision: first.revision,
    beforeRunId: first.recentRuns[0]!.id,
    limit: 1,
  })
  assert.equal(second.runs.length, 1)
  assert.equal(second.nextBeforeRunId, second.runs[0]!.id)
  const third = controller.listRuns({
    expectedRevision: first.revision,
    beforeRunId: second.nextBeforeRunId!,
    limit: 1,
  })
  assert.equal(third.runs.length, 1)
  assert.equal(third.nextBeforeRunId, undefined)

  controller.queueRun({
    operationId: '84111111-1111-4111-8111-111111111111',
    automationId: AUTOMATION_ID,
  })
  assert.throws(() => controller.listRuns({
    expectedRevision: first.revision,
    beforeRunId: third.runs[0]!.id,
    limit: 1,
  }), /history changed/)
})
