import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopWorktreeCleanupConfirmInput,
  parseDesktopWorktreeCleanupPreviewInput,
  parseWorktreeCleanupPreview,
  parseWorktreeCleanupResult,
} from './worktree-cleanup.js'

const previewId = '11111111-1111-4111-8111-111111111111'
const worktree = {
  id: '22222222-2222-4222-8222-222222222222',
  repositoryRoot: '/repo',
  requestedBySessionId: 'session-source',
  sessionState: 'bound' as const,
  sessionId: 'session-worktree',
  executionMode: 'worktree' as const,
  worktreePath: '/managed/worktree',
  baseRef: 'refs/heads/main',
  baseCommit: 'a'.repeat(40),
  branch: 'refs/heads/dsh/session-123',
  lifecycle: 'ready' as const,
  createdAt: '2026-08-16T12:00:00.000Z',
  updatedAt: '2026-08-16T12:01:00.000Z',
}
const inspection = {
  worktreePath: '/managed/worktree',
  head: 'b'.repeat(40),
  branch: 'refs/heads/dsh/session-123',
  clean: true as const,
  locked: true as const,
  changes: [] as [],
}

test('validates cleanup preview and explicit confirmation inputs', () => {
  assert.deepEqual(parseDesktopWorktreeCleanupPreviewInput({ worktreeId: worktree.id }), {
    worktreeId: worktree.id,
  })
  assert.equal(parseDesktopWorktreeCleanupPreviewInput({ worktreeId: 'not-an-id' }), undefined)
  assert.deepEqual(parseDesktopWorktreeCleanupConfirmInput({ previewId, confirmed: true }), {
    previewId,
    confirmed: true,
  })
  assert.equal(parseDesktopWorktreeCleanupConfirmInput({ previewId, confirmed: false }), undefined)
})

test('binds cleanup previews to one clean locked managed checkout', () => {
  assert.deepEqual(parseWorktreeCleanupPreview({
    canRemove: true,
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    worktree,
    inspection,
  })?.inspection, inspection)
  assert.equal(parseWorktreeCleanupPreview({
    canRemove: true,
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    worktree,
    inspection: { ...inspection, clean: false, changes: [] },
  }), undefined)
  assert.equal(parseWorktreeCleanupPreview({
    canRemove: true,
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    worktree: { ...worktree, worktreePath: '/other' },
    inspection,
  }), undefined)
})

test('returns a bounded dirty assessment without issuing a cleanup credential', () => {
  const blocked = {
    canRemove: false,
    worktree,
    inspection: {
      ...inspection,
      clean: false,
      changes: [{
        kind: 'ignored',
        path: 'private.local',
        indexStatus: '!',
        worktreeStatus: '!',
      }],
    },
  }
  assert.deepEqual(parseWorktreeCleanupPreview(blocked), blocked)
  assert.equal(parseWorktreeCleanupPreview({ ...blocked, previewId }), undefined)
  assert.equal(parseWorktreeCleanupPreview({
    ...blocked,
    inspection: { ...blocked.inspection, changes: [] },
  }), undefined)
})

test('accepts only terminal removed cleanup results', () => {
  assert.equal(parseWorktreeCleanupResult({ operationId: previewId, worktree }), undefined)
  assert.equal(parseWorktreeCleanupResult({
    operationId: previewId,
    worktree: { ...worktree, lifecycle: 'removed' },
  })?.worktree.lifecycle, 'removed')
})
