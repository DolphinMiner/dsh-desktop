import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopWorktreeHandoffPreflightInput,
  parseWorktreeHandoffPreflight,
  type WorktreeHandoffPreflight,
} from './worktree-handoff.js'

const worktree = {
  id: '11111111-1111-4111-8111-111111111111',
  repositoryRoot: '/repo',
  requestedBySessionId: 'request-session',
  sessionState: 'pending' as const,
  executionMode: 'worktree' as const,
  worktreePath: '/managed/worktree',
  baseRef: 'refs/heads/main',
  baseCommit: 'a'.repeat(40),
  branch: 'refs/heads/dsh/session-123456789012345678901234',
  lifecycle: 'ready' as const,
  createdAt: '2026-08-16T12:00:00.000Z',
  updatedAt: '2026-08-16T12:00:01.000Z',
}

function preflight(overrides: Partial<WorktreeHandoffPreflight> = {}): WorktreeHandoffPreflight {
  return {
    direction: 'local-to-worktree',
    worktree,
    baseCommit: 'a'.repeat(40),
    source: { kind: 'local', path: '/repo', branch: 'main', head: 'b'.repeat(40), clean: false },
    destination: {
      kind: 'worktree',
      path: '/managed/worktree',
      branch: 'dsh/session-123456789012345678901234',
      head: 'a'.repeat(40),
      clean: true,
    },
    files: [
      { status: 'modified', path: 'src/index.ts', patchAvailable: true },
      { status: 'untracked', path: 'notes.txt', patchAvailable: false },
    ],
    patch: 'diff --git a/src/index.ts b/src/index.ts\n',
    blockers: [],
    canTransfer: true,
    ...overrides,
  }
}

test('validates exact handoff preflight requests', () => {
  assert.deepEqual(parseDesktopWorktreeHandoffPreflightInput({
    worktreeId: worktree.id,
    direction: 'worktree-to-local',
  }), { worktreeId: worktree.id, direction: 'worktree-to-local' })
  assert.equal(parseDesktopWorktreeHandoffPreflightInput({
    worktreeId: worktree.id,
    direction: 'worktree-to-local',
    path: '/tmp/injected',
  }), undefined)
})

test('binds handoff endpoints to the managed worktree direction', () => {
  assert.deepEqual(parseWorktreeHandoffPreflight(preflight()), preflight())
  assert.equal(parseWorktreeHandoffPreflight(preflight({
    destination: { ...preflight().destination, path: '/other' },
  })), undefined)
  assert.equal(parseWorktreeHandoffPreflight(preflight({
    files: [{ status: 'untracked', path: 'notes.txt', patchAvailable: true }],
  })), undefined)
})

test('requires blocker and transfer truth to agree', () => {
  const blocked = preflight({ blockers: ['destination-dirty'], canTransfer: false })
  assert.deepEqual(parseWorktreeHandoffPreflight(blocked), blocked)
  assert.equal(parseWorktreeHandoffPreflight({ ...blocked, canTransfer: true }), undefined)
  assert.equal(parseWorktreeHandoffPreflight({
    ...blocked,
    blockers: ['destination-dirty', 'destination-dirty'],
  }), undefined)
})
