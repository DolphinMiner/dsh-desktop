import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopGitCommitConfirmInput,
  parseDesktopGitCommitPreviewInput,
  parseGitCommitParams,
  parseGitCommitPreview,
  parseGitCommitResult,
} from './git-commit.js'

const previewId = '11111111-1111-4111-8111-111111111111'
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }
const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
const head = 'a'.repeat(40)
const commit = 'b'.repeat(40)
const tree = 'c'.repeat(40)
const review = {
  repository,
  scope: { kind: 'staged' as const },
  head,
  files: [{ status: 'modified' as const, path: 'src/example.ts', patchAvailable: true }],
  patch: '',
}

test('validates staged commit preview and explicit confirmation inputs', () => {
  assert.deepEqual(parseDesktopGitCommitPreviewInput(workspace), workspace)
  assert.deepEqual(parseDesktopGitCommitConfirmInput({
    ...workspace,
    previewId,
    message: 'feat: preserve exact staged state\n\nDetails',
    confirmed: true,
  }), {
    ...workspace,
    previewId,
    message: 'feat: preserve exact staged state\n\nDetails',
    confirmed: true,
  })
  assert.equal(parseDesktopGitCommitConfirmInput({ ...workspace, previewId, message: '  ', confirmed: true }), undefined)
  assert.equal(parseDesktopGitCommitConfirmInput({ ...workspace, previewId, message: 'valid', confirmed: false }), undefined)
})

test('binds commit contracts to staged snapshots, object identities, and the resulting HEAD', () => {
  assert.equal(parseGitCommitPreview({
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    review,
  })?.review.scope.kind, 'staged')
  assert.equal(parseGitCommitPreview({
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    review: { ...review, scope: { kind: 'unstaged' } },
  }), undefined)
  assert.equal(parseGitCommitParams({
    ...workspace,
    repositoryRoot: '/repo',
    operationId: previewId,
    message: 'feat: test',
    expectedHead: head,
    expectedTree: tree,
  })?.expectedTree, tree)
  assert.equal(parseGitCommitResult({
    operationId: previewId,
    commit,
    status: {
      repository,
      head: commit,
      branch: 'main',
      ahead: 0,
      behind: 0,
      clean: true,
      entries: [],
    },
  })?.commit, commit)
  assert.equal(parseGitCommitResult({
    operationId: previewId,
    commit,
    status: {
      repository,
      head,
      branch: 'main',
      ahead: 0,
      behind: 0,
      clean: true,
      entries: [],
    },
  }), undefined)
})
