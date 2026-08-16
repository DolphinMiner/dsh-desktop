import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { TestContext } from 'node:test'

import type { AutomationDefinitionDraft } from './automation-registry'
import { AutomationRegistry } from './automation-registry'
import {
  AutomationDispatcher,
  AutomationDispatcherError,
  AutomationWorkspaceManager,
  AutomationWorkspacePreparer,
} from './automation-dispatcher'

const HOST_ONE = '11111111-1111-4111-8111-111111111111'
const HOST_TWO = '22222222-2222-4222-8222-222222222222'

function definition(root: string, overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    name: 'Repository review',
    prompt: 'Review the repository and summarize actionable changes.',
    projectPath: root,
    repository: { root, gitDir: join(root, '.git'), commonDir: join(root, '.git') },
    trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
    concurrencyPolicy: 'skip',
    skillIds: [],
    connectionIds: [],
    state: 'enabled',
    nextTriggerAt: '2026-08-17T09:00:00.000Z',
    ...overrides,
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-dispatcher-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new AutomationRegistry(join(root, 'automations.v1.json'), {
    now: () => new Date('2026-08-16T04:00:00.000Z'),
  })
  return { root, registry }
}

function queue(registry: AutomationRegistry, root: string, suffix: string) {
  const created = registry.createDefinition({
    operationId: `create-${suffix}`,
    definition: definition(root),
  })
  return registry.queueRun({
    operationId: `queue-${suffix}`,
    automationId: created.automationId,
    invocation: { kind: 'manual' },
  })
}

test('persists one exact Host claim and restores a lost response without redispatch', async t => {
  const { root, registry } = await fixture(t)
  const queued = queue(registry, root, 'claim')
  let preparations = 0
  const workspaces: AutomationWorkspacePreparer = {
    prepare: async () => {
      preparations += 1
      return {
        workspacePath: '/managed/automation-claim',
        worktreeId: '33333333-3333-4333-8333-333333333333',
      }
    },
  }
  const dispatcher = new AutomationDispatcher(registry, workspaces)

  const first = await dispatcher.claimNext({ hostInstanceId: HOST_ONE }, new AbortController().signal)
  assert.equal(first?.run.id, queued.id)
  assert.equal(first?.run.phase, 'dispatching')
  assert.equal(first?.workspacePath, '/managed/automation-claim')
  assert.equal(preparations, 1)

  const duplicate = await dispatcher.claimNext({ hostInstanceId: HOST_ONE }, new AbortController().signal)
  assert.equal(duplicate?.run.id, queued.id)
  assert.equal(preparations, 1)
  assert.equal(await dispatcher.claimNext({ hostInstanceId: HOST_TWO }, new AbortController().signal), undefined)

  const restored = new AutomationRegistry(join(root, 'automations.v1.json'))
  const recoveredResponse = await new AutomationDispatcher(restored, workspaces)
    .claimNext({ hostInstanceId: HOST_ONE }, new AbortController().signal)
  assert.equal(recoveredResponse?.run.id, queued.id)
  assert.equal(preparations, 1)
})

test('records workspace preparation failure before selecting more work', async t => {
  const { root, registry } = await fixture(t)
  const queued = queue(registry, root, 'workspace-failure')
  const dispatcher = new AutomationDispatcher(registry, {
    prepare: async () => {
      throw new AutomationDispatcherError('TARGET_CHANGED', 'The repository was replaced.', true)
    },
  })

  await assert.rejects(
    dispatcher.claimNext({ hostInstanceId: HOST_ONE }, new AbortController().signal),
    (error: AutomationDispatcherError) => error.code === 'CONFLICT' && error.ambiguous === false,
  )
  const failed = registry.getRun(queued.id)!
  assert.equal(failed.phase, 'failed')
  const terminal = failed.events.at(-1)
  assert.match(terminal?.type === 'terminal' ? terminal.detail ?? '' : '', /replaced/)
})

test('accepts lifecycle evidence only from the Host that owns the run', async t => {
  const { root, registry } = await fixture(t)
  const queued = queue(registry, root, 'lifecycle')
  const dispatcher = new AutomationDispatcher(registry, {
    prepare: async () => ({ workspacePath: '/managed/lifecycle' }),
  })
  await dispatcher.claimNext({ hostInstanceId: HOST_ONE }, new AbortController().signal)
  assert.equal(dispatcher.inspectOwned({ hostInstanceId: HOST_ONE })?.id, queued.id)
  assert.equal(dispatcher.inspectOwned({ hostInstanceId: HOST_TWO }), undefined)

  assert.throws(() => dispatcher.markRunning({
    hostInstanceId: HOST_TWO,
    runId: queued.id,
    sessionEventSeq: 4,
  }), (error: AutomationDispatcherError) => error.code === 'PERMISSION_DENIED')
  assert.equal(dispatcher.markRunning({
    hostInstanceId: HOST_ONE,
    runId: queued.id,
    sessionEventSeq: 4,
  }).phase, 'running')
  const finished = dispatcher.finish({
    hostInstanceId: HOST_ONE,
    runId: queued.id,
    outcome: 'succeeded',
    sessionEventSeq: 9,
  })
  assert.equal(finished.phase, 'succeeded')
  assert.equal(dispatcher.finish({
    hostInstanceId: HOST_ONE,
    runId: queued.id,
    outcome: 'succeeded',
    sessionEventSeq: 9,
  }).events.length, finished.events.length)
  assert.equal(dispatcher.inspectOwned({ hostInstanceId: HOST_ONE }), undefined)
})

test('atomically makes every abandoned claimed run ambiguous without touching queued work', async t => {
  const { root, registry } = await fixture(t)
  queue(registry, root, 'recovery-one')
  const secondRoot = join(root, 'second')
  queue(registry, secondRoot, 'recovery-two')
  const thirdRoot = join(root, 'third')
  queue(registry, thirdRoot, 'still-queued')
  const dispatcher = new AutomationDispatcher(registry, {
    prepare: async run => ({ workspacePath: `/managed/${run.id}` }),
  })
  const firstClaim = (await dispatcher.claimNext(
    { hostInstanceId: HOST_ONE },
    new AbortController().signal,
  ))!
  const secondClaim = (await dispatcher.claimNext(
    { hostInstanceId: HOST_TWO },
    new AbortController().signal,
  ))!
  dispatcher.markRunning({ hostInstanceId: HOST_ONE, runId: firstClaim.run.id, sessionEventSeq: 1 })
  const revision = registry.status().revision

  const recovered = dispatcher.recoverAbandonedRuns()
  assert.equal(recovered.length, 2)
  assert.equal(registry.status().revision, revision + 1)
  assert.equal(registry.getRun(firstClaim.run.id)?.phase, 'ambiguous')
  assert.equal(registry.getRun(secondClaim.run.id)?.phase, 'ambiguous')
  const untouched = registry.snapshot().runs.find(run =>
    run.id !== firstClaim.run.id && run.id !== secondClaim.run.id)
  assert.equal(untouched?.phase, 'queued')
  assert.deepEqual(dispatcher.recoverAbandonedRuns(), [])
  const restored = new AutomationRegistry(join(root, 'automations.v1.json'))
  assert.equal(restored.getRun(firstClaim.run.id)?.phase, 'ambiguous')
  assert.equal(restored.getRun(secondClaim.run.id)?.phase, 'ambiguous')
})

test('prepares local and nested managed-worktree paths from exact repository identity', async t => {
  const { root, registry } = await fixture(t)
  const repositoryRoot = await realpath(root)
  const nested = join(repositoryRoot, 'packages', 'app')
  await mkdir(nested, { recursive: true })
  const repository = {
    root: repositoryRoot,
    gitDir: join(repositoryRoot, '.git'),
    commonDir: join(repositoryRoot, '.git'),
  }
  const localDefinition = registry.createDefinition({
    operationId: 'create-local-workspace',
    definition: definition(repositoryRoot, {
      projectPath: nested,
      repository,
      execution: { mode: 'local' },
    }),
  })
  const localRun = registry.queueRun({
    operationId: 'queue-local-workspace',
    automationId: localDefinition.automationId,
    invocation: { kind: 'manual' },
  })
  let provisioned = false
  const workspaceManager = new AutomationWorkspaceManager({
    discoverRepository: async () => repository,
  }, {
    provisionAutomation: async () => {
      provisioned = true
      throw new Error('local execution must not provision a worktree')
    },
  })
  assert.deepEqual(await workspaceManager.prepare(localRun, new AbortController().signal), {
    workspacePath: nested,
  })
  assert.equal(provisioned, false)

  const managedRoot = join(repositoryRoot, 'managed')
  const managedNested = join(managedRoot, 'packages', 'app')
  await mkdir(managedNested, { recursive: true })
  const worktreeDefinition = registry.createDefinition({
    operationId: 'create-worktree-workspace',
    definition: definition(repositoryRoot, { projectPath: nested, repository }),
  })
  const worktreeRun = registry.queueRun({
    operationId: 'queue-worktree-workspace',
    automationId: worktreeDefinition.automationId,
    invocation: { kind: 'manual' },
  })
  const exactInputs: unknown[] = []
  const worktreeManager = new AutomationWorkspaceManager({
    discoverRepository: async () => repository,
  }, {
    provisionAutomation: async input => {
      exactInputs.push(input)
      return {
        created: true,
        record: {
          id: '44444444-4444-4444-8444-444444444444',
          repository,
          requestedBySessionId: worktreeRun.payload.sessionId,
          executionMode: 'worktree',
          worktreePath: managedRoot,
          baseRef: 'refs/heads/main',
          baseCommit: 'a'.repeat(40),
          branch: 'refs/heads/dsh/session-automation',
          lifecycle: 'ready',
          creationOperationId: `automation-worktree:${worktreeRun.id}`,
          createdAt: '2026-08-16T04:00:00.000Z',
          updatedAt: '2026-08-16T04:00:00.000Z',
        },
      }
    },
  })
  assert.deepEqual(await worktreeManager.prepare(worktreeRun, new AbortController().signal), {
    workspacePath: managedNested,
    worktreeId: '44444444-4444-4444-8444-444444444444',
  })
  assert.equal(exactInputs.length, 1)
  assert.deepEqual(exactInputs[0], {
    operationId: `automation-worktree:${worktreeRun.id}`,
    requestedBySessionId: worktreeRun.payload.sessionId,
    workspaceRoot: nested,
    baseRef: 'refs/heads/main',
    repository,
  })
})
