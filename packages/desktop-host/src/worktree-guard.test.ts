import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorktreeSummary } from '@dolphinminer/dsh-desktop-protocol'

import { WorktreeSessionConflictError, WorktreeSessionGuard } from './worktree-guard.js'

function worktree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    repositoryRoot: '/repo',
    requestedBySessionId: 'session-source',
    sessionState: 'pending',
    executionMode: 'worktree',
    worktreePath: '/managed/worktree',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-source',
    lifecycle: 'ready',
    createdAt: '2026-08-16T12:00:00.000Z',
    updatedAt: '2026-08-16T12:00:01.000Z',
    ...overrides,
  }
}

test('claims a pending checkout synchronously and rejects a second session', () => {
  const guard = new WorktreeSessionGuard()
  assert.equal(guard.applySnapshot({ revision: 2, worktrees: [worktree()] }), true)
  assert.deepEqual(guard.claim('session-created', '/managed/worktree'), {
    managed: true,
    recordId: '11111111-1111-4111-8111-111111111111',
  })
  assert.deepEqual(guard.claim('session-created', '/managed/worktree'), {
    managed: true,
    recordId: '11111111-1111-4111-8111-111111111111',
  })
  assert.throws(() => guard.claim('session-other', '/managed/worktree'), WorktreeSessionConflictError)
  assert.deepEqual(guard.claim('session-local', '/unmanaged'), { managed: false })
})

test('applies monotonic changes and blocks unresolved recovery records', () => {
  const guard = new WorktreeSessionGuard()
  guard.applySnapshot({ revision: 4, worktrees: [] })
  assert.equal(guard.applyChange({ revision: 3, worktree: worktree() }), false)
  assert.deepEqual(guard.claim('session-created', '/managed/worktree'), { managed: false })

  assert.equal(guard.applyChange({
    revision: 5,
    worktree: worktree({ lifecycle: 'recovery-required', recoveryReason: 'interrupted-create' }),
  }), true)
  assert.throws(() => guard.claim('session-created', '/managed/worktree'), WorktreeSessionConflictError)
  assert.equal(guard.applyChange({
    revision: 6,
    worktree: worktree({ lifecycle: 'removed' }),
  }), true)
  assert.deepEqual(guard.claim('session-created', '/managed/worktree'), { managed: false })
})

test('replaces the complete projection from one monotonic reconciliation snapshot', () => {
  const guard = new WorktreeSessionGuard()
  const removed = worktree()
  const recovered = worktree({
    id: '22222222-2222-4222-8222-222222222222',
    requestedBySessionId: 'session-recovered',
    worktreePath: '/managed/recovered',
    branch: 'refs/heads/dsh/session-recovered',
  })
  assert.equal(guard.applySnapshot({ revision: 5, worktrees: [removed] }), true)
  assert.equal(guard.applySnapshot({ revision: 6, worktrees: [recovered] }), true)
  assert.deepEqual(guard.claim('session-old', '/managed/worktree'), { managed: false })
  assert.deepEqual(guard.claim('session-new', '/managed/recovered'), {
    managed: true,
    recordId: recovered.id,
  })
  assert.equal(guard.applySnapshot({ revision: 6, worktrees: [removed] }), false)
  assert.deepEqual(guard.claim('session-old', '/managed/worktree'), { managed: false })
})
