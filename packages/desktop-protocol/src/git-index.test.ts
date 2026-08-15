import assert from 'node:assert/strict'
import test from 'node:test'

import { parseDesktopGitIndexMutationInput, parseGitIndexMutationResult } from './git-index.js'

const requestId = '11111111-1111-4111-8111-111111111111'

test('validates bounded, duplicate-free Git index mutations', () => {
  assert.deepEqual(parseDesktopGitIndexMutationInput({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    requestId,
    kind: 'stage',
    paths: ['src/a.ts', 'src/b.ts'],
  }), {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    requestId,
    kind: 'stage',
    paths: ['src/a.ts', 'src/b.ts'],
  })
  assert.equal(parseDesktopGitIndexMutationInput({
    sessionId: 'session-1', workspaceRoot: '/repo', requestId, kind: 'stage', paths: ['src/a.ts', 'src/a.ts'],
  }), undefined)
  assert.equal(parseDesktopGitIndexMutationInput({
    sessionId: 'session-1', workspaceRoot: '/repo', requestId, kind: 'reset', paths: ['src/a.ts'],
  }), undefined)
})

test('validates index mutation results against the authoritative status contract', () => {
  assert.deepEqual(parseGitIndexMutationResult({
    operationId: requestId,
    kind: 'unstage',
    status: {
      repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
      head: 'a'.repeat(40),
      branch: 'main',
      ahead: 0,
      behind: 0,
      clean: false,
      entries: [{
        kind: 'ordinary',
        path: 'src/a.ts',
        indexStatus: '.',
        worktreeStatus: 'M',
      }],
    },
  })?.kind, 'unstage')
})
