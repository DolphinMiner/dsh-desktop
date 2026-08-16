import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {
  AutomationDispatchClaim,
  AutomationRunSummary,
  WorktreeSessionBindingResult,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  AutomationDesktopClient,
  AutomationExecutionHandle,
  AutomationRunCoordinator,
  AutomationSessionExecutor,
  AutomationTerminalEvidence,
  summarizeAutomationEvents,
} from './automation-runner.js'

const HOST_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const AUTOMATION_ID = '33333333-3333-4333-8333-333333333333'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'
const WORKTREE_ID = '55555555-5555-4555-8555-555555555555'

function run(cancellationRequested = false): AutomationRunSummary {
  const events: AutomationRunSummary['events'] = [
    {
      seq: 1,
      operationId: 'queue-run',
      at: '2026-08-16T04:00:00.000Z',
      type: 'queued',
    },
    {
      seq: 2,
      operationId: `dispatch:${RUN_ID}:${HOST_ID}`,
      at: '2026-08-16T04:00:01.000Z',
      type: 'dispatch',
      hostInstanceId: HOST_ID,
      workspacePath: '/managed/project',
      worktreeId: WORKTREE_ID,
    },
  ]
  if (cancellationRequested) {
    events.push({
      seq: 3,
      operationId: 'cancel-run',
      at: '2026-08-16T04:00:02.000Z',
      type: 'cancel-requested',
      reason: 'No longer needed.',
    })
  }
  return {
    id: RUN_ID,
    automationId: AUTOMATION_ID,
    payloadHash: 'a'.repeat(64),
    payload: {
      definitionRevision: 1,
      definitionName: 'Repository review',
      prompt: 'Review this repository.',
      projectPath: '/repo',
      repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
      trigger: { kind: 'once', at: '2026-08-16T04:00:00.000Z' },
      execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
      concurrencyPolicy: 'skip',
      skillIds: [],
      connectionIds: [],
      invocation: { kind: 'manual', requestedAt: '2026-08-16T04:00:00.000Z' },
      sessionId: SESSION_ID,
    },
    phase: 'dispatching',
    cancellationRequested,
    createdAt: '2026-08-16T04:00:00.000Z',
    updatedAt: cancellationRequested
      ? '2026-08-16T04:00:02.000Z'
      : '2026-08-16T04:00:01.000Z',
    events,
  }
}

function dispatch(cancellationRequested = false): AutomationDispatchClaim {
  return {
    run: run(cancellationRequested),
    workspacePath: '/managed/project',
    worktreeId: WORKTREE_ID,
  }
}

class FakeDesktop implements AutomationDesktopClient {
  readonly order: string[] = []
  readonly finishes: AutomationTerminalEvidence[] = []
  claims: AutomationDispatchClaim[] = [dispatch()]
  markError?: Error
  ambiguousFinishFailures = 0

  claimNext(): Promise<AutomationDispatchClaim | undefined> {
    this.order.push('claim')
    return Promise.resolve(this.claims.shift())
  }

  bindSession(): Promise<WorktreeSessionBindingResult> {
    this.order.push('bind')
    return Promise.resolve({ managed: true, worktree: { id: WORKTREE_ID } as never })
  }

  markRunning(): Promise<AutomationRunSummary> {
    this.order.push('mark-running')
    if (this.markError !== undefined) return Promise.reject(this.markError)
    return Promise.resolve({ ...run(), phase: 'running' })
  }

  finish(_hostInstanceId: string, _runId: string, evidence: AutomationTerminalEvidence): Promise<AutomationRunSummary> {
    this.order.push('finish')
    this.finishes.push({ ...evidence })
    if (this.ambiguousFinishFailures > 0) {
      this.ambiguousFinishFailures -= 1
      return Promise.reject(Object.assign(new Error('response lost'), { ambiguous: true }))
    }
    return Promise.resolve({ ...run(), phase: evidence.outcome })
  }
}

class FakeExecution implements AutomationExecutionHandle {
  readonly sessionId = SESSION_ID
  readonly publicationSeq = 7
  disposed = 0
  cancelled = 0

  constructor(
    private readonly order: string[],
    private readonly evidence: AutomationTerminalEvidence = {
      outcome: 'succeeded',
      sessionEventSeq: 12,
      detail: 'Done.',
    },
  ) {}

  execute(): Promise<AutomationTerminalEvidence> {
    this.order.push('execute')
    return Promise.resolve(this.evidence)
  }

  cancel(): void {
    this.cancelled += 1
  }

  dispose(): Promise<void> {
    this.order.push('dispose')
    this.disposed += 1
    return Promise.resolve()
  }
}

class FakeExecutor implements AutomationSessionExecutor {
  readonly execution: FakeExecution
  prepares = 0

  constructor(private readonly order: string[]) {
    this.execution = new FakeExecution(order)
  }

  prepare(): Promise<AutomationExecutionHandle> {
    this.order.push('prepare')
    this.prepares += 1
    return Promise.resolve(this.execution)
  }
}

test('binds and marks the official Session running before submitting one prompt', async () => {
  const desktop = new FakeDesktop()
  const executor = new FakeExecutor(desktop.order)
  const coordinator = new AutomationRunCoordinator(HOST_ID, desktop, executor)

  await coordinator.wake()

  assert.deepEqual(desktop.order, [
    'claim',
    'prepare',
    'bind',
    'mark-running',
    'execute',
    'finish',
    'dispose',
    'claim',
  ])
  assert.deepEqual(desktop.finishes, [{
    outcome: 'succeeded',
    sessionEventSeq: 12,
    detail: 'Done.',
  }])
  assert.equal(executor.prepares, 1)
  assert.equal(executor.execution.disposed, 1)
  await coordinator.dispose()
})

test('never submits the prompt after an ambiguous running acknowledgement', async () => {
  const desktop = new FakeDesktop()
  desktop.markError = Object.assign(new Error('response lost'), { ambiguous: true })
  const executor = new FakeExecutor(desktop.order)
  const coordinator = new AutomationRunCoordinator(HOST_ID, desktop, executor)

  await coordinator.wake()

  assert.equal(desktop.order.includes('execute'), false)
  assert.equal(desktop.finishes[0]?.outcome, 'ambiguous')
  assert.match(desktop.finishes[0]?.detail ?? '', /no automation prompt was submitted/)
  assert.equal(executor.execution.disposed, 1)
  await coordinator.dispose()
})

test('retries only the exact terminal report after an ambiguous acknowledgement', async () => {
  const desktop = new FakeDesktop()
  desktop.ambiguousFinishFailures = 1
  const executor = new FakeExecutor(desktop.order)
  const coordinator = new AutomationRunCoordinator(HOST_ID, desktop, executor)

  await coordinator.wake()

  assert.equal(desktop.order.filter(item => item === 'execute').length, 1)
  assert.equal(desktop.order.filter(item => item === 'finish').length, 2)
  assert.deepEqual(desktop.finishes[0], desktop.finishes[1])
  await coordinator.dispose()
})

test('finishes a claimed cancellation without creating an Agent Session', async () => {
  const desktop = new FakeDesktop()
  desktop.claims = [dispatch(true)]
  const executor = new FakeExecutor(desktop.order)
  const coordinator = new AutomationRunCoordinator(HOST_ID, desktop, executor)

  await coordinator.wake()

  assert.equal(executor.prepares, 0)
  assert.equal(desktop.finishes[0]?.outcome, 'cancelled')
  await coordinator.dispose()
})

function turnEvents(reason: TurnEndReason): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 4, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 5, time: 2, data: { turn: 1, reason } },
  ] as SessionEvent[]
}

test('maps official durable turn endings to automation outcomes', () => {
  assert.deepEqual(summarizeAutomationEvents(turnEvents({ kind: 'completed' }), 4), {
    outcome: 'succeeded',
    sessionEventSeq: 5,
  })
  assert.equal(summarizeAutomationEvents(turnEvents({
    kind: 'error',
    error: { code: 'UNKNOWN', message: 'model failed' },
  }), 4).outcome, 'failed')
  assert.equal(summarizeAutomationEvents(turnEvents({ kind: 'blocked' }), 4).outcome, 'failed')
  assert.equal(summarizeAutomationEvents(turnEvents({ kind: 'max-tokens' }), 4).outcome, 'failed')
  assert.equal(summarizeAutomationEvents(turnEvents({
    kind: 'aborted',
    reason: { kind: 'user' },
  }), 4).outcome, 'cancelled')
  assert.equal(summarizeAutomationEvents(turnEvents({
    kind: 'aborted',
    reason: { kind: 'disposed' },
  }), 4).outcome, 'interrupted')
  assert.equal(summarizeAutomationEvents(turnEvents({ kind: 'interrupted' }), 4).outcome, 'interrupted')
  assert.equal(summarizeAutomationEvents([], 4).outcome, 'ambiguous')
})
