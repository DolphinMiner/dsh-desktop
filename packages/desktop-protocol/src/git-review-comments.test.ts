import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseAddGitReviewCommentInput,
  parseDeleteGitReviewCommentInput,
  parseGitReviewCommentSnapshot,
} from './git-review-comments.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const anchor = {
  path: 'src/example.ts',
  side: 'new' as const,
  line: 12,
  blob: 'a'.repeat(40),
}

test('validates bounded review comment mutations and snapshots', () => {
  assert.deepEqual(parseAddGitReviewCommentInput({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    requestId,
    scope: { kind: 'unstaged' },
    anchor,
    body: 'Please keep this branch explicit.',
  }), {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    requestId,
    scope: { kind: 'unstaged' },
    anchor,
    body: 'Please keep this branch explicit.',
  })
  assert.deepEqual(parseDeleteGitReviewCommentInput({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    commentId: requestId,
  }), {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    commentId: requestId,
  })
  assert.deepEqual(parseGitReviewCommentSnapshot({
    revision: 1,
    repositoryCommonDir: '/repo/.git',
    comments: [{ id: requestId, anchor, body: 'Review note', createdAt: '2026-08-16T12:00:00.000Z' }],
  })?.comments[0]?.anchor, anchor)
})

test('rejects empty bodies, absent blobs, invalid lines, and extra mutation fields', () => {
  const base = {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    requestId,
    scope: { kind: 'unstaged' },
    anchor,
    body: 'Review note',
  }
  assert.equal(parseAddGitReviewCommentInput({ ...base, body: '   ' }), undefined)
  assert.equal(parseAddGitReviewCommentInput({ ...base, anchor: { ...anchor, blob: '0'.repeat(40) } }), undefined)
  assert.equal(parseAddGitReviewCommentInput({ ...base, anchor: { ...anchor, line: 0 } }), undefined)
  assert.equal(parseAddGitReviewCommentInput({ ...base, apiKey: 'must-not-pass' }), undefined)
})
