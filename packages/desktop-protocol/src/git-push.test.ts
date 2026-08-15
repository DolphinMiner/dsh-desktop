import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopGitPushConfirmInput,
  parseDesktopGitPushPreviewInput,
  parseGitPushParams,
  parseGitPushPreview,
  parseGitPushResult,
  parseGitPushState,
} from './git-push.js'

const previewId = '11111111-1111-4111-8111-111111111111'
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }
const target = {
  remote: 'origin',
  remoteUrl: 'https://github.com/example/repo.git',
  localBranch: 'feature/review',
  localRef: 'refs/heads/feature/review',
  remoteRef: 'refs/heads/feature/review',
  trackingRef: 'refs/remotes/origin/feature/review',
  head: 'a'.repeat(40),
  upstreamHead: 'b'.repeat(40),
  ahead: 2,
  behind: 0,
}

test('validates push preview and explicit confirmation inputs', () => {
  assert.deepEqual(parseDesktopGitPushPreviewInput(workspace), workspace)
  assert.deepEqual(parseDesktopGitPushConfirmInput({ ...workspace, previewId, confirmed: true }), {
    ...workspace,
    previewId,
    confirmed: true,
  })
  assert.equal(parseDesktopGitPushConfirmInput({ ...workspace, previewId, confirmed: false }), undefined)
  assert.equal(parseDesktopGitPushPreviewInput({ ...workspace, extra: true }), undefined)
})

test('keeps raw remote URL fingerprints out of renderer previews', () => {
  assert.deepEqual(parseGitPushPreview({
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    target,
  })?.target, target)
  assert.equal(parseGitPushPreview({
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    target: { ...target, remoteUrlFingerprint: 'c'.repeat(64) },
  }), undefined)
  assert.equal(parseGitPushState({ ...target, remoteUrlFingerprint: 'c'.repeat(64) })?.remote, 'origin')
  assert.equal(parseGitPushState({ ...target, remoteUrlFingerprint: 'not-a-hash' }), undefined)
})

test('binds internal Push dispatch and results to exact operation identities', () => {
  const operationId = '22222222-2222-4222-8222-222222222222'
  const state = { ...target, remoteUrlFingerprint: 'c'.repeat(64) }
  assert.deepEqual(parseGitPushParams({
    ...workspace,
    repositoryRoot: '/repo',
    operationId,
    target: state,
  }), {
    ...workspace,
    repositoryRoot: '/repo',
    operationId,
    target: state,
  })
  assert.equal(parseGitPushParams({
    ...workspace,
    repositoryRoot: '/repo',
    operationId,
    target,
  }), undefined)
  assert.deepEqual(parseGitPushResult({
    operationId,
    remote: 'origin',
    remoteRef: 'refs/heads/feature/review',
    head: 'a'.repeat(40),
  }), {
    operationId,
    remote: 'origin',
    remoteRef: 'refs/heads/feature/review',
    head: 'a'.repeat(40),
  })
  assert.equal(parseGitPushResult({
    operationId,
    remote: 'origin',
    remoteRef: 'refs/tags/review',
    head: 'a'.repeat(40),
  }), undefined)
})
