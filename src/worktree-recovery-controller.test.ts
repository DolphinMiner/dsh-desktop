import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  ExternalChangeWorktreeRecoveryInspection,
  MissingWorktreeRecoveryInspection,
  MovedWorktreeRecoveryInspection,
  WorktreeCleanupInspection,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  WorktreeRecoveryController,
  WorktreeRecoveryControllerError,
  type WorktreeRecoveryOperations,
} from './worktree-recovery-controller'
import type {
  ExternalChangeWorktreeRecoveryState,
  InterruptedRemovalRecoveryState,
  MissingWorktreeRecoveryState,
  MovedWorktreeRecoveryState,
} from './worktree-manager'
import type { WorktreeRecord } from './worktree-registry'
import { writeJsonAtomically } from './atomic-json'
import {
  WorktreeRelocationJournal,
  worktreeRelocationPhase,
} from './worktree-relocation-journal'

const previewId = '11111111-1111-4111-8111-111111111111'
const worktreeId = '22222222-2222-4222-8222-222222222222'
const signal = new AbortController().signal

function record(): WorktreeRecord {
  return {
    id: worktreeId,
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    requestedBySessionId: 'request-session',
    executionMode: 'worktree',
    worktreePath: '/managed/worktree',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    lifecycle: 'recovery-required',
    creationOperationId: 'create-worktree',
    pendingOperation: { id: 'remove-worktree', kind: 'remove' },
    recoveryReason: 'interrupted-remove',
    createdAt: '2026-08-16T12:00:00.000Z',
    updatedAt: '2026-08-16T12:01:00.000Z',
  }
}

function cloneRecord(value: WorktreeRecord): WorktreeRecord {
  return {
    ...value,
    repository: { ...value.repository },
    ...(value.pendingOperation === undefined ? {} : { pendingOperation: { ...value.pendingOperation } }),
  }
}

class FakeRecovery implements WorktreeRecoveryOperations {
  current = record()
  inspection: WorktreeCleanupInspection = {
    worktreePath: '/managed/worktree',
    head: 'b'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    clean: false,
    locked: true,
    changes: [{
      kind: 'untracked',
      path: 'notes.txt',
      indexStatus: '?',
      worktreeStatus: '?',
    }],
  }
  keepCalls = 0
  forgetCalls = 0
  beforeCommit?: () => void
  missingInspection: MissingWorktreeRecoveryInspection = {
    repositoryRoot: '/repo',
    worktreePath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    worktreeMetadataAbsent: true,
    checkoutPathAbsent: true,
  }
  movedInspection: MovedWorktreeRecoveryInspection = {
    repositoryRoot: '/repo',
    registeredPath: '/managed/worktree',
    current: {
      worktreePath: '/managed/moved',
      head: 'b'.repeat(40),
      branch: 'refs/heads/dsh/session-123456789012345678901234',
      clean: false,
      locked: true,
      changes: [{
        kind: 'untracked',
        path: 'notes.txt',
        indexStatus: '?',
        worktreeStatus: '?',
      }],
    },
    registeredPathAbsent: true,
  }
  moveCalls = 0
  moveOutcome: 'completed' | 'not-applied' | 'ambiguous' = 'completed'
  moveError?: Error
  moveGate?: Promise<void>
  moveStarted?: () => void
  beforeMoveDispatch?: () => void
  externalInspection: ExternalChangeWorktreeRecoveryInspection = {
    registeredRepository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    registeredPath: '/managed/worktree',
    registeredBranch: 'refs/heads/dsh/session-123456789012345678901234',
    checkoutPathPresent: true,
    repositoryRootObservation: {
      state: 'matching',
      identity: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    },
    checkoutObservation: {
      state: 'changed',
      identity: {
        root: '/managed/worktree',
        gitDir: '/managed/worktree/.git',
        commonDir: '/managed/worktree/.git',
      },
    },
    registrationObservation: { state: 'missing' },
  }
  stopTrackingCalls = 0
  stopTrackingOperationId?: string
  stopTrackingGate?: Promise<void>

  getByStopTrackingOperation(operationId: string): WorktreeRecord | undefined {
    return this.stopTrackingOperationId === operationId && this.current.lifecycle === 'removed'
      ? cloneRecord(this.current)
      : undefined
  }

  get(id: string): WorktreeRecord | undefined {
    return id === worktreeId ? cloneRecord(this.current) : undefined
  }

  async inspectInterruptedRemoval(id: string): Promise<InterruptedRemovalRecoveryState> {
    assert.equal(id, worktreeId)
    return {
      record: cloneRecord(this.current),
      inspection: structuredClone(this.inspection),
      removalOperationId: this.current.pendingOperation!.id,
    }
  }

  async keepInterruptedRemoval(
    id: string,
    removalOperationId: string,
    expected: WorktreeCleanupInspection,
    _signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    assert.equal(id, worktreeId)
    assert.equal(removalOperationId, 'remove-worktree')
    assert.deepEqual(expected, this.inspection)
    this.beforeCommit?.()
    beforeCommit?.(cloneRecord(this.current))
    this.keepCalls += 1
    this.current = {
      ...this.current,
      lifecycle: this.current.sessionId === undefined ? 'orphaned' : 'ready',
    }
    delete this.current.pendingOperation
    delete this.current.recoveryReason
    return cloneRecord(this.current)
  }

  async inspectMissingWorktree(id: string): Promise<MissingWorktreeRecoveryState> {
    assert.equal(id, worktreeId)
    return {
      record: cloneRecord(this.current),
      inspection: { ...this.missingInspection },
    }
  }

  async forgetMissingWorktree(
    id: string,
    resolutionOperationId: string,
    expected: MissingWorktreeRecoveryInspection,
    _signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    assert.equal(id, worktreeId)
    assert.equal(resolutionOperationId, previewId)
    assert.deepEqual(expected, this.missingInspection)
    this.beforeCommit?.()
    beforeCommit?.(cloneRecord(this.current))
    this.forgetCalls += 1
    this.current = {
      ...this.current,
      lifecycle: 'removed',
      removalOperationId: resolutionOperationId,
    }
    delete this.current.pendingOperation
    delete this.current.recoveryReason
    return cloneRecord(this.current)
  }

  async inspectMovedWorktree(id: string): Promise<MovedWorktreeRecoveryState> {
    assert.equal(id, worktreeId)
    return {
      record: cloneRecord(this.current),
      inspection: structuredClone(this.movedInspection),
    }
  }

  async restoreMovedWorktree(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    _signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    assert.equal(id, worktreeId)
    assert.deepEqual(expected, this.movedInspection)
    this.beforeMoveDispatch?.()
    beforeDispatch?.(cloneRecord(this.current))
    this.moveCalls += 1
    this.moveStarted?.()
    await this.moveGate
    if (this.moveError !== undefined) throw this.moveError
    this.current = {
      ...this.current,
      lifecycle: this.current.sessionId === undefined ? 'orphaned' : 'ready',
    }
    delete this.current.pendingOperation
    delete this.current.recoveryReason
    return cloneRecord(this.current)
  }

  async inspectMovedWorktreeOutcome(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
  ): Promise<'completed' | 'not-applied' | 'ambiguous'> {
    assert.equal(id, worktreeId)
    assert.deepEqual(expected, this.movedInspection)
    return this.moveOutcome
  }

  async completeMovedWorktreeRecovery(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
  ): Promise<WorktreeRecord> {
    assert.equal(id, worktreeId)
    assert.deepEqual(expected, this.movedInspection)
    this.current = {
      ...this.current,
      lifecycle: this.current.sessionId === undefined ? 'orphaned' : 'ready',
    }
    delete this.current.pendingOperation
    delete this.current.recoveryReason
    return cloneRecord(this.current)
  }

  async inspectExternalChangeWorktree(id: string): Promise<ExternalChangeWorktreeRecoveryState> {
    assert.equal(id, worktreeId)
    return {
      record: cloneRecord(this.current),
      inspection: structuredClone(this.externalInspection),
    }
  }

  async stopTrackingExternalChange(
    id: string,
    resolutionOperationId: string,
    expected: ExternalChangeWorktreeRecoveryInspection,
    _signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    assert.equal(id, worktreeId)
    assert.deepEqual(expected, this.externalInspection)
    this.beforeCommit?.()
    beforeCommit?.(cloneRecord(this.current))
    await this.stopTrackingGate
    this.stopTrackingCalls += 1
    this.stopTrackingOperationId = resolutionOperationId
    this.current = {
      ...this.current,
      lifecycle: 'removed',
      removalOperationId: `stop-tracking:${resolutionOperationId}`,
    }
    delete this.current.pendingOperation
    delete this.current.recoveryReason
    return cloneRecord(this.current)
  }
}

async function relocationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-recovery-controller-test-'))
  return { root, path: join(root, 'worktree-relocations.v1.json') }
}

function prepareMoved(worktrees: FakeRecovery): void {
  worktrees.current.recoveryReason = 'moved'
  delete worktrees.current.pendingOperation
}

function prepareExternalChange(worktrees: FakeRecovery): void {
  worktrees.current.recoveryReason = 'external-change'
  delete worktrees.current.pendingOperation
}

test('keeps an exact interrupted cleanup after renderer and native approval', async () => {
  const worktrees = new FakeRecovery()
  let approval: object | undefined
  const controller = new WorktreeRecoveryController(worktrees, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
    approve: async details => {
      approval = details
      return true
    },
  })

  const preview = await controller.preview({
    worktreeId,
    action: 'keep-interrupted-removal',
  }, signal)
  assert.equal(preview.expiresAt, '2026-08-16T12:05:00.000Z')
  if (preview.action !== 'keep-interrupted-removal') assert.fail('Expected an interrupted-removal preview.')
  assert.equal(preview.inspection.clean, false)
  const result = await controller.confirm({ previewId, confirmed: true }, signal)
  assert.equal(result.worktree.lifecycle, 'orphaned')
  assert.equal(worktrees.keepCalls, 1)
  assert.deepEqual(approval, {
    action: 'keep-interrupted-removal',
    repositoryRoot: '/repo',
    worktreePath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    head: 'b'.repeat(40),
    clean: false,
    changeCount: 1,
  })
  await assert.rejects(controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'NOT_FOUND')
  assert.equal(worktrees.keepCalls, 1)
})

test('rejects drift, native denial, and a session that starts at the final boundary', async () => {
  const drifted = new FakeRecovery()
  const driftController = new WorktreeRecoveryController(drifted, {
    randomId: () => previewId,
    approve: async () => true,
  })
  await driftController.preview({ worktreeId, action: 'keep-interrupted-removal' }, signal)
  drifted.inspection = { ...drifted.inspection, head: 'c'.repeat(40) }
  await assert.rejects(driftController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /after preview/i.test(error.message))
  assert.equal(drifted.keepCalls, 0)

  const denied = new FakeRecovery()
  const deniedController = new WorktreeRecoveryController(denied, {
    randomId: () => previewId,
    approve: async () => false,
  })
  await deniedController.preview({ worktreeId, action: 'keep-interrupted-removal' }, signal)
  await assert.rejects(deniedController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CANCELLED')
  assert.equal(denied.keepCalls, 0)

  const raced = new FakeRecovery()
  raced.current.sessionId = 'harness-session'
  let running = false
  raced.beforeCommit = () => { running = true }
  const racedController = new WorktreeRecoveryController(raced, {
    randomId: () => previewId,
    approve: async () => true,
    isSessionRunning: sessionId => sessionId === 'harness-session' && running,
  })
  await racedController.preview({ worktreeId, action: 'keep-interrupted-removal' }, signal)
  await assert.rejects(racedController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /active Harness session/i.test(error.message))
  assert.equal(raced.keepCalls, 0)
})

test('expires previews and restores a retained bound checkout to ready', async () => {
  const expired = new FakeRecovery()
  let now = Date.parse('2026-08-16T12:00:00.000Z')
  const expiredController = new WorktreeRecoveryController(expired, {
    now: () => new Date(now),
    randomId: () => previewId,
    previewTtlMs: 1_000,
    approve: async () => true,
  })
  await expiredController.preview({ worktreeId, action: 'keep-interrupted-removal' }, signal)
  now += 1_000
  await assert.rejects(expiredController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /expired/i.test(error.message))
  assert.equal(expired.keepCalls, 0)

  const bound = new FakeRecovery()
  bound.current.sessionId = 'harness-session'
  const boundController = new WorktreeRecoveryController(bound, {
    randomId: () => previewId,
    approve: async () => true,
    isSessionRunning: () => false,
  })
  await boundController.preview({ worktreeId, action: 'keep-interrupted-removal' }, signal)
  const result = await boundController.confirm({ previewId, confirmed: true }, signal)
  assert.equal(result.worktree.lifecycle, 'ready')
  assert.equal(result.worktree.sessionState, 'bound')
  assert.equal(bound.keepCalls, 1)
})

test('forgets only exact missing-checkout evidence after both approvals', async () => {
  const missing = new FakeRecovery()
  missing.current.recoveryReason = 'missing'
  delete missing.current.pendingOperation
  let approval: object | undefined
  const controller = new WorktreeRecoveryController(missing, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
    approve: async details => {
      approval = details
      return true
    },
  })

  const preview = await controller.preview({ worktreeId, action: 'forget-missing' }, signal)
  assert.equal(preview.action, 'forget-missing')
  if (preview.action !== 'forget-missing') assert.fail('Expected a missing-worktree preview.')
  assert.equal(preview.inspection.worktreeMetadataAbsent, true)
  assert.equal(preview.inspection.checkoutPathAbsent, true)
  const result = await controller.confirm({ previewId, confirmed: true }, signal)
  assert.equal(result.action, 'forget-missing')
  assert.equal(result.worktree.lifecycle, 'removed')
  assert.equal(missing.forgetCalls, 1)
  assert.deepEqual(approval, {
    action: 'forget-missing',
    repositoryRoot: '/repo',
    worktreePath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
  })
  await assert.rejects(controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'NOT_FOUND')
  assert.equal(missing.forgetCalls, 1)
})

test('rejects missing-checkout drift and an active-session race before forgetting', async () => {
  const drifted = new FakeRecovery()
  drifted.current.recoveryReason = 'missing'
  delete drifted.current.pendingOperation
  const driftController = new WorktreeRecoveryController(drifted, {
    randomId: () => previewId,
    approve: async () => true,
  })
  await driftController.preview({ worktreeId, action: 'forget-missing' }, signal)
  drifted.missingInspection = { ...drifted.missingInspection, branch: 'refs/heads/other' }
  await assert.rejects(driftController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /after preview/i.test(error.message))
  assert.equal(drifted.forgetCalls, 0)

  const raced = new FakeRecovery()
  raced.current.recoveryReason = 'missing'
  delete raced.current.pendingOperation
  raced.current.sessionId = 'harness-session'
  let running = false
  raced.beforeCommit = () => { running = true }
  const racedController = new WorktreeRecoveryController(raced, {
    randomId: () => previewId,
    approve: async () => true,
    isSessionRunning: sessionId => sessionId === 'harness-session' && running,
  })
  await racedController.preview({ worktreeId, action: 'forget-missing' }, signal)
  await assert.rejects(racedController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /active Harness session/i.test(error.message))
  assert.equal(raced.forgetCalls, 0)
})

test('stops tracking an exact external identity after dual approval and deduplicates the tombstone', async () => {
  const worktrees = new FakeRecovery()
  prepareExternalChange(worktrees)
  let approval: object | undefined
  let releaseStop: (() => void) | undefined
  let signalStarted: (() => void) | undefined
  worktrees.stopTrackingGate = new Promise(resolve => { releaseStop = resolve })
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  worktrees.beforeCommit = signalStarted
  const controller = new WorktreeRecoveryController(worktrees, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
    approve: async details => {
      approval = details
      return true
    },
  })

  const preview = await controller.preview({ worktreeId, action: 'stop-tracking' }, signal)
  if (preview.action !== 'stop-tracking') assert.fail('Expected an external-change preview.')
  assert.equal(preview.inspection.checkoutObservation.state, 'changed')
  const first = controller.confirm({ previewId, confirmed: true }, signal)
  await started
  const concurrent = controller.confirm({ previewId, confirmed: true }, signal)
  releaseStop?.()
  const [result, concurrentResult] = await Promise.all([first, concurrent])
  assert.deepEqual(concurrentResult, result)
  assert.equal(result.action, 'stop-tracking')
  assert.equal(result.worktree.lifecycle, 'removed')
  assert.equal(worktrees.stopTrackingCalls, 1)
  assert.deepEqual(approval, {
    action: 'stop-tracking',
    repositoryRoot: '/repo',
    worktreePath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    repositoryState: 'matching',
    checkoutState: 'changed',
    registrationState: 'missing',
  })
  assert.deepEqual(await controller.confirm({ previewId, confirmed: true }, signal), result)
  assert.deepEqual(await new WorktreeRecoveryController(worktrees).confirm({
    previewId,
    confirmed: true,
  }, signal), result)
  assert.equal(worktrees.stopTrackingCalls, 1)
})

test('rejects external identity drift and an active-session race before stopping tracking', async () => {
  const drifted = new FakeRecovery()
  prepareExternalChange(drifted)
  const driftController = new WorktreeRecoveryController(drifted, {
    randomId: () => previewId,
    approve: async () => true,
  })
  await driftController.preview({ worktreeId, action: 'stop-tracking' }, signal)
  drifted.externalInspection = {
    ...drifted.externalInspection,
    checkoutObservation: {
      state: 'changed',
      identity: {
        root: '/managed/worktree',
        gitDir: '/replacement/.git',
        commonDir: '/replacement/.git',
      },
    },
  }
  await assert.rejects(driftController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /after preview/i.test(error.message))
  assert.equal(drifted.stopTrackingCalls, 0)

  const raced = new FakeRecovery()
  prepareExternalChange(raced)
  raced.current.sessionId = 'harness-session'
  let running = false
  raced.beforeCommit = () => { running = true }
  const racedController = new WorktreeRecoveryController(raced, {
    randomId: () => previewId,
    approve: async () => true,
    isSessionRunning: sessionId => sessionId === 'harness-session' && running,
  })
  await racedController.preview({ worktreeId, action: 'stop-tracking' }, signal)
  await assert.rejects(racedController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /active Harness session/i.test(error.message))
  assert.equal(raced.stopTrackingCalls, 0)
  assert.equal(raced.current.lifecycle, 'recovery-required')
})

test('restores a moved checkout after exact renderer and native approval and deduplicates the result', async t => {
  const fixture = await relocationFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const worktrees = new FakeRecovery()
  prepareMoved(worktrees)
  const journal = new WorktreeRelocationJournal(fixture.path)
  let approval: object | undefined
  const controller = new WorktreeRecoveryController(worktrees, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
    relocationJournal: journal,
    approve: async details => {
      approval = details
      return true
    },
  })

  const preview = await controller.preview({ worktreeId, action: 'restore-moved' }, signal)
  if (preview.action !== 'restore-moved') assert.fail('Expected a moved-worktree preview.')
  assert.equal(preview.inspection.current.worktreePath, '/managed/moved')
  assert.equal(preview.inspection.registeredPath, '/managed/worktree')
  const result = await controller.confirm({ previewId, confirmed: true }, signal)
  assert.equal(result.action, 'restore-moved')
  assert.equal(result.worktree.lifecycle, 'orphaned')
  assert.equal(worktrees.moveCalls, 1)
  assert.equal(worktreeRelocationPhase(journal.get(previewId)!), 'succeeded')
  assert.deepEqual(approval, {
    action: 'restore-moved',
    repositoryRoot: '/repo',
    currentPath: '/managed/moved',
    registeredPath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    head: 'b'.repeat(40),
    clean: false,
    changeCount: 1,
  })

  const duplicate = await controller.confirm({ previewId, confirmed: true }, signal)
  assert.deepEqual(duplicate, result)
  assert.equal(worktrees.moveCalls, 1)
})

test('serializes concurrent confirmation and performs one moved-checkout dispatch', async t => {
  const fixture = await relocationFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const worktrees = new FakeRecovery()
  prepareMoved(worktrees)
  let releaseMove: (() => void) | undefined
  let signalStarted: (() => void) | undefined
  worktrees.moveGate = new Promise(resolve => { releaseMove = resolve })
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  worktrees.moveStarted = signalStarted
  const controller = new WorktreeRecoveryController(worktrees, {
    randomId: () => previewId,
    relocationJournal: new WorktreeRelocationJournal(fixture.path),
    approve: async () => true,
  })
  await controller.preview({ worktreeId, action: 'restore-moved' }, signal)

  const first = controller.confirm({ previewId, confirmed: true }, signal)
  await started
  const second = controller.confirm({ previewId, confirmed: true }, signal)
  releaseMove?.()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.deepEqual(secondResult, firstResult)
  assert.equal(worktrees.moveCalls, 1)
})

test('stops before Git when the final active-session guard or dispatch journal write fails', async t => {
  const activeFixture = await relocationFixture()
  t.after(() => rm(activeFixture.root, { recursive: true, force: true }))
  const active = new FakeRecovery()
  prepareMoved(active)
  active.current.sessionId = 'harness-session'
  let running = false
  active.beforeMoveDispatch = () => { running = true }
  const activeJournal = new WorktreeRelocationJournal(activeFixture.path)
  const activeController = new WorktreeRecoveryController(active, {
    randomId: () => previewId,
    relocationJournal: activeJournal,
    approve: async () => true,
    isSessionRunning: sessionId => sessionId === 'harness-session' && running,
  })
  await activeController.preview({ worktreeId, action: 'restore-moved' }, signal)
  await assert.rejects(activeController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /active Harness session/i.test(error.message))
  assert.equal(active.moveCalls, 0)
  assert.equal(worktreeRelocationPhase(activeJournal.get(previewId)!), 'cancelled')

  const persistenceFixture = await relocationFixture()
  t.after(() => rm(persistenceFixture.root, { recursive: true, force: true }))
  const persistence = new FakeRecovery()
  prepareMoved(persistence)
  let writes = 0
  const persistenceJournal = new WorktreeRelocationJournal(persistenceFixture.path, {
    write: (path, value) => {
      writes += 1
      if (writes === 2) throw new Error('disk full before dispatch')
      writeJsonAtomically(path, value)
    },
  })
  const persistenceController = new WorktreeRecoveryController(persistence, {
    randomId: () => previewId,
    relocationJournal: persistenceJournal,
    approve: async () => true,
  })
  await persistenceController.preview({ worktreeId, action: 'restore-moved' }, signal)
  await assert.rejects(persistenceController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'DESKTOP_UNAVAILABLE' && !error.ambiguous)
  assert.equal(persistence.moveCalls, 0)
  const recovered = new WorktreeRelocationJournal(persistenceFixture.path)
  assert.equal(worktreeRelocationPhase(recovered.get(previewId)!), 'cancelled')
})

test('reconciles post-dispatch success or failure without replaying the move', async t => {
  const completedFixture = await relocationFixture()
  t.after(() => rm(completedFixture.root, { recursive: true, force: true }))
  const completed = new FakeRecovery()
  prepareMoved(completed)
  completed.moveError = new Error('Git acknowledgement lost')
  completed.moveOutcome = 'completed'
  const completedJournal = new WorktreeRelocationJournal(completedFixture.path)
  const completedController = new WorktreeRecoveryController(completed, {
    randomId: () => previewId,
    relocationJournal: completedJournal,
    approve: async () => true,
  })
  await completedController.preview({ worktreeId, action: 'restore-moved' }, signal)
  const result = await completedController.confirm({ previewId, confirmed: true }, signal)
  assert.equal(result.worktree.lifecycle, 'orphaned')
  assert.equal(completed.moveCalls, 1)
  assert.equal(worktreeRelocationPhase(completedJournal.get(previewId)!), 'succeeded')

  const failedFixture = await relocationFixture()
  t.after(() => rm(failedFixture.root, { recursive: true, force: true }))
  const failed = new FakeRecovery()
  prepareMoved(failed)
  failed.moveError = new Error('Git rejected the move')
  failed.moveOutcome = 'not-applied'
  const failedJournal = new WorktreeRelocationJournal(failedFixture.path)
  const failedController = new WorktreeRecoveryController(failed, {
    randomId: () => previewId,
    relocationJournal: failedJournal,
    approve: async () => true,
  })
  await failedController.preview({ worktreeId, action: 'restore-moved' }, signal)
  await assert.rejects(failedController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && /not moved/.test(error.message))
  assert.equal(failed.moveCalls, 1)
  assert.equal(worktreeRelocationPhase(failedJournal.get(previewId)!), 'failed')
  await assert.rejects(failedController.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(failed.moveCalls, 1)
})

test('keeps an ambiguous move unresolved and blocks a fresh approval from replaying it', async t => {
  const fixture = await relocationFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const worktrees = new FakeRecovery()
  prepareMoved(worktrees)
  worktrees.moveError = new Error('Git timed out')
  worktrees.moveOutcome = 'ambiguous'
  const journal = new WorktreeRelocationJournal(fixture.path)
  const ids = [previewId, '33333333-3333-4333-8333-333333333333']
  const controller = new WorktreeRecoveryController(worktrees, {
    randomId: () => ids.shift()!,
    relocationJournal: journal,
    approve: async () => true,
  })
  await controller.preview({ worktreeId, action: 'restore-moved' }, signal)
  await assert.rejects(controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'CONFLICT' && error.ambiguous)
  assert.equal(worktreeRelocationPhase(journal.get(previewId)!), 'ambiguous')

  const fresh = await controller.preview({ worktreeId, action: 'restore-moved' }, signal)
  await assert.rejects(controller.confirm({ previewId: fresh.previewId, confirmed: true }, signal),
    (error: WorktreeRecoveryControllerError) => error.code === 'DUPLICATE_REQUEST' && /unresolved/.test(error.message))
  assert.equal(worktrees.moveCalls, 1)
})

test('reconciles cold-restart moved-checkout outcomes without dispatching again', async t => {
  const completedFixture = await relocationFixture()
  t.after(() => rm(completedFixture.root, { recursive: true, force: true }))
  const completedWorktrees = new FakeRecovery()
  prepareMoved(completedWorktrees)
  const first = new WorktreeRelocationJournal(completedFixture.path)
  first.begin({
    operationId: previewId,
    worktreeId,
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    inspection: completedWorktrees.movedInspection,
    fingerprint: 'd'.repeat(64),
  })
  first.recordDispatch(previewId)
  const restarted = new WorktreeRelocationJournal(completedFixture.path)
  assert.equal(worktreeRelocationPhase(restarted.get(previewId)!), 'ambiguous')
  completedWorktrees.moveOutcome = 'completed'
  await new WorktreeRecoveryController(completedWorktrees, {
    relocationJournal: restarted,
  }).reconcileRelocations(signal)
  assert.equal(completedWorktrees.moveCalls, 0)
  assert.equal(completedWorktrees.current.lifecycle, 'orphaned')
  assert.equal(worktreeRelocationPhase(restarted.get(previewId)!), 'succeeded')

  const notAppliedFixture = await relocationFixture()
  t.after(() => rm(notAppliedFixture.root, { recursive: true, force: true }))
  const notAppliedWorktrees = new FakeRecovery()
  prepareMoved(notAppliedWorktrees)
  const beforeRestart = new WorktreeRelocationJournal(notAppliedFixture.path)
  beforeRestart.begin({
    operationId: previewId,
    worktreeId,
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    inspection: notAppliedWorktrees.movedInspection,
    fingerprint: 'e'.repeat(64),
  })
  beforeRestart.recordDispatch(previewId)
  const notAppliedJournal = new WorktreeRelocationJournal(notAppliedFixture.path)
  notAppliedWorktrees.moveOutcome = 'not-applied'
  await new WorktreeRecoveryController(notAppliedWorktrees, {
    relocationJournal: notAppliedJournal,
  }).reconcileRelocations(signal)
  assert.equal(notAppliedWorktrees.moveCalls, 0)
  assert.equal(notAppliedWorktrees.current.lifecycle, 'recovery-required')
  assert.equal(worktreeRelocationPhase(notAppliedJournal.get(previewId)!), 'failed')
})

test('leaves cold-restart recovery ambiguous when the registered repository identity changed', async t => {
  const fixture = await relocationFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const worktrees = new FakeRecovery()
  prepareMoved(worktrees)
  const beforeRestart = new WorktreeRelocationJournal(fixture.path)
  beforeRestart.begin({
    operationId: previewId,
    worktreeId,
    repository: { ...worktrees.current.repository },
    inspection: worktrees.movedInspection,
    fingerprint: 'f'.repeat(64),
  })
  beforeRestart.recordDispatch(previewId)
  const restarted = new WorktreeRelocationJournal(fixture.path)
  worktrees.current.repository = { ...worktrees.current.repository, commonDir: '/other/.git' }
  worktrees.moveOutcome = 'completed'

  await new WorktreeRecoveryController(worktrees, {
    relocationJournal: restarted,
  }).reconcileRelocations(signal)

  assert.equal(worktrees.moveCalls, 0)
  assert.equal(worktrees.current.lifecycle, 'recovery-required')
  assert.equal(worktreeRelocationPhase(restarted.get(previewId)!), 'ambiguous')
})
