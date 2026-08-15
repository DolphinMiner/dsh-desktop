import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorktreeCleanupInspection } from '@dolphinminer/dsh-desktop-protocol'

import {
  WorktreeCleanupController,
  WorktreeCleanupControllerError,
  type WorktreeCleanupOperations,
} from './worktree-cleanup-controller'
import { WorktreeManagerError } from './worktree-manager'
import type { WorktreeRecord } from './worktree-registry'

const previewId = '11111111-1111-4111-8111-111111111111'
const worktreeId = '22222222-2222-4222-8222-222222222222'
const signal = new AbortController().signal

function worktreeRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: worktreeId,
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    requestedBySessionId: 'request-session',
    executionMode: 'worktree',
    worktreePath: '/managed/worktree',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    lifecycle: 'ready',
    creationOperationId: 'create-worktree',
    createdAt: '2026-08-16T12:00:00.000Z',
    updatedAt: '2026-08-16T12:00:00.000Z',
    ...overrides,
  }
}

function cloneRecord(record: WorktreeRecord): WorktreeRecord {
  return {
    ...record,
    repository: { ...record.repository },
    ...(record.pendingOperation === undefined ? {} : { pendingOperation: { ...record.pendingOperation } }),
  }
}

class FakeWorktrees implements WorktreeCleanupOperations {
  record = worktreeRecord()
  inspection: WorktreeCleanupInspection = {
    worktreePath: '/managed/worktree',
    head: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    clean: true,
    locked: true,
  }
  inspectCalls = 0
  removeCalls = 0
  removeError?: Error
  beforeGuard?: () => void

  async inspectCleanup(id: string) {
    assert.equal(id, this.record.id)
    this.inspectCalls += 1
    return { record: cloneRecord(this.record), inspection: { ...this.inspection } }
  }

  getByOperation(operationId: string): WorktreeRecord | undefined {
    if (this.record.pendingOperation?.id === operationId || this.record.removalOperationId === operationId) {
      return cloneRecord(this.record)
    }
    return undefined
  }

  async removeCleanWorktree(
    id: string,
    operationId: string,
    expected: WorktreeCleanupInspection,
    _signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    assert.equal(id, this.record.id)
    assert.deepEqual(expected, this.inspection)
    this.beforeGuard?.()
    beforeDispatch?.(cloneRecord(this.record))
    this.removeCalls += 1
    this.record = {
      ...this.record,
      lifecycle: 'removing',
      pendingOperation: { id: operationId, kind: 'remove' },
    }
    if (this.removeError !== undefined) throw this.removeError
    this.record = {
      ...this.record,
      lifecycle: 'removed',
      removalOperationId: operationId,
    }
    delete this.record.pendingOperation
    return cloneRecord(this.record)
  }
}

test('binds cleanup to an exact preview and returns a successful retry without replay', async () => {
  const worktrees = new FakeWorktrees()
  let approval: object | undefined
  const controller = new WorktreeCleanupController(worktrees, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
    approve: async details => {
      approval = details
      return true
    },
  })

  const preview = await controller.preview({ worktreeId }, signal)
  assert.equal(preview.previewId, previewId)
  assert.equal(preview.expiresAt, '2026-08-16T12:05:00.000Z')
  assert.equal(preview.worktree.lifecycle, 'ready')
  assert.equal(preview.inspection.head, 'a'.repeat(40))
  const first = await controller.confirm({ previewId, confirmed: true }, signal)
  const duplicate = await controller.confirm({ previewId, confirmed: true }, signal)
  assert.deepEqual(duplicate, first)
  assert.equal(worktrees.removeCalls, 1)
  assert.deepEqual(approval, {
    repositoryRoot: '/repo',
    worktreePath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    head: 'a'.repeat(40),
  })
})

test('expires previews and honors native cancellation before durable cleanup intent', async () => {
  let currentTime = Date.parse('2026-08-16T12:00:00.000Z')
  const expiredWorktrees = new FakeWorktrees()
  const expired = new WorktreeCleanupController(expiredWorktrees, {
    now: () => new Date(currentTime),
    randomId: () => previewId,
    previewTtlMs: 1_000,
    approve: async () => true,
  })
  await expired.preview({ worktreeId }, signal)
  currentTime += 1_001
  await assert.rejects(expired.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'CONFLICT' && /expired/i.test(error.message))
  assert.equal(expiredWorktrees.removeCalls, 0)

  const deniedWorktrees = new FakeWorktrees()
  const denied = new WorktreeCleanupController(deniedWorktrees, {
    randomId: () => previewId,
    approve: async () => false,
  })
  await denied.preview({ worktreeId }, signal)
  await assert.rejects(denied.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'CANCELLED')
  assert.equal(deniedWorktrees.removeCalls, 0)
})

test('revalidates the complete worktree state before and after native approval', async () => {
  const changedBefore = new FakeWorktrees()
  const first = new WorktreeCleanupController(changedBefore, {
    randomId: () => previewId,
    approve: async () => true,
  })
  await first.preview({ worktreeId }, signal)
  changedBefore.record.updatedAt = '2026-08-16T12:01:00.000Z'
  await assert.rejects(first.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'CONFLICT' && /after preview/i.test(error.message))
  assert.equal(changedBefore.removeCalls, 0)

  const changedDuring = new FakeWorktrees()
  const second = new WorktreeCleanupController(changedDuring, {
    randomId: () => previewId,
    approve: async () => {
      changedDuring.inspection.head = 'b'.repeat(40)
      return true
    },
  })
  await second.preview({ worktreeId }, signal)
  await assert.rejects(second.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'CONFLICT' && /during approval/i.test(error.message))
  assert.equal(changedDuring.removeCalls, 0)
})

test('blocks active sessions, including one that starts at the final dispatch boundary', async () => {
  const active = new FakeWorktrees()
  active.record.sessionId = 'harness-session'
  let running = true
  const first = new WorktreeCleanupController(active, {
    randomId: () => previewId,
    approve: async () => true,
    isSessionRunning: sessionId => sessionId === 'harness-session' && running,
  })
  await assert.rejects(first.preview({ worktreeId }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'CONFLICT' && /active Harness session/i.test(error.message))

  running = false
  const second = new WorktreeCleanupController(active, {
    randomId: () => previewId,
    approve: async () => true,
    isSessionRunning: sessionId => sessionId === 'harness-session' && running,
  })
  await second.preview({ worktreeId }, signal)
  active.beforeGuard = () => { running = true }
  await assert.rejects(second.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'CONFLICT' && /active Harness session/i.test(error.message))
  assert.equal(active.removeCalls, 0)
  assert.equal(active.record.lifecycle, 'ready')
})

test('does not replay an ambiguous cleanup operation', async () => {
  const worktrees = new FakeWorktrees()
  worktrees.removeError = new WorktreeManagerError('TIMEOUT', 'Git cleanup timed out.', true)
  const controller = new WorktreeCleanupController(worktrees, {
    randomId: () => previewId,
    approve: async () => true,
  })
  await controller.preview({ worktreeId }, signal)

  await assert.rejects(controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeManagerError) => error.code === 'TIMEOUT' && error.ambiguous)
  await assert.rejects(controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeCleanupControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(worktrees.removeCalls, 1)
})
