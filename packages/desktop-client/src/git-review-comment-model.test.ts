import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitReviewComment, ReviewPatchFile } from '@dolphinminer/dsh-desktop-protocol'

import { anchorForDiffLine, projectGitReviewComments } from './git-review-comment-model.js'

const oldBlob = '1'.repeat(40)
const newBlob = '2'.repeat(40)
const file: ReviewPatchFile = {
  path: 'example.ts',
  oldBlob,
  newBlob,
  binary: false,
  hunks: [{
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'same' },
      { kind: 'deletion', oldLine: 2, text: 'old' },
      { kind: 'addition', newLine: 2, text: 'new' },
    ],
  }],
}

test('anchors additions, deletions, and context to immutable nonzero blobs', () => {
  assert.deepEqual(anchorForDiffLine(file, file.hunks[0]!.lines[0]!), {
    path: 'example.ts', side: 'new', line: 1, blob: newBlob,
  })
  assert.deepEqual(anchorForDiffLine(file, file.hunks[0]!.lines[1]!), {
    path: 'example.ts', side: 'old', line: 2, blob: oldBlob,
  })
  assert.deepEqual(anchorForDiffLine(file, file.hunks[0]!.lines[2]!), {
    path: 'example.ts', side: 'new', line: 2, blob: newBlob,
  })
  assert.equal(anchorForDiffLine({ ...file, newBlob: '0'.repeat(40) }, file.hunks[0]!.lines[2]!), undefined)
})

test('projects comments as active, stale, or outside the selected review', () => {
  const comment = (id: string, path: string, blob: string): GitReviewComment => ({
    id,
    anchor: { path, side: 'new', line: 2, blob },
    body: 'Review note',
    createdAt: '2026-08-16T12:00:00.000Z',
  })
  assert.deepEqual(projectGitReviewComments([file], [
    comment('11111111-1111-4111-8111-111111111111', 'example.ts', newBlob),
    comment('22222222-2222-4222-8222-222222222222', 'example.ts', '3'.repeat(40)),
    comment('33333333-3333-4333-8333-333333333333', 'other.ts', newBlob),
  ]).map(item => item.state), ['active', 'stale', 'out-of-scope'])
})
