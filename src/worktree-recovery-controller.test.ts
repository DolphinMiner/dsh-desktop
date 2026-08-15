import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  MissingWorktreeRecoveryInspection,
  WorktreeCleanupInspection,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  WorktreeRecoveryController,
  WorktreeRecoveryControllerError,
  type WorktreeRecoveryOperations,
} from './worktree-recovery-controller'
import type { InterruptedRemovalRecoveryState, MissingWorktreeRecoveryState } from './worktree-manager'
import type { WorktreeRecord } from './worktree-registry'

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
