import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopGitRevertConfirmInput,
  parseDesktopGitRevertPreviewInput,
  parseGitRevertPreview,
} from './git-revert.js'

const previewId = '11111111-1111-4111-8111-111111111111'
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }
const review = {
  repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
  scope: { kind: 'unstaged' as const },
  head: 'a'.repeat(40),
  files: [{ status: 'modified' as const, path: 'src/example.ts', patchAvailable: true }],
  patch: '',
}

test('validates bounded revert preview and explicit confirmation requests', () => {
  assert.deepEqual(parseDesktopGitRevertPreviewInput({ ...workspace, path: 'src/example.ts' }), {
    ...workspace,
    path: 'src/example.ts',
  })
  assert.deepEqual(parseDesktopGitRevertConfirmInput({ ...workspace, previewId, confirmed: true }), {
    ...workspace,
    previewId,
    confirmed: true,
  })
  assert.equal(parseDesktopGitRevertConfirmInput({ ...workspace, previewId, confirmed: false }), undefined)
  assert.equal(parseDesktopGitRevertPreviewInput({ ...workspace, path: '' }), undefined)
})

test('binds a revert preview to an unstaged review containing the selected path', () => {
  assert.equal(parseGitRevertPreview({
    previewId,
    path: 'src/example.ts',
    expiresAt: '2026-08-16T12:05:00.000Z',
    review,
  })?.path, 'src/example.ts')
  assert.equal(parseGitRevertPreview({
    previewId,
    path: 'other.ts',
    expiresAt: '2026-08-16T12:05:00.000Z',
    review,
  }), undefined)
  assert.equal(parseGitRevertPreview({
    previewId,
    path: 'src/example.ts',
    expiresAt: 'invalid',
    review,
  }), undefined)
})
