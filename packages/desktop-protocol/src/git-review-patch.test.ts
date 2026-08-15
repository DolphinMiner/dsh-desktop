import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitReviewCommentAnchor } from './git-review-comments.js'
import { classifyGitReviewAnchor, parseGitReviewPatch } from './git-review-patch.js'

test('parses Git patches into stable file, hunk, and line coordinates', () => {
  const files = parseGitReviewPatch([
    'diff --git a/src/example.ts b/src/example.ts',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    '@@ -1,2 +1,3 @@',
    ' first',
    '-old',
    '+new',
    '+tail',
    '',
  ].join('\n'))

  assert.deepEqual(files, [{
    path: 'src/example.ts',
    oldBlob: '1111111111111111111111111111111111111111',
    newBlob: '2222222222222222222222222222222222222222',
    binary: false,
    hunks: [{
      header: '@@ -1,2 +1,3 @@',
      lines: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'first' },
        { kind: 'deletion', oldLine: 2, text: 'old' },
        { kind: 'addition', newLine: 2, text: 'new' },
        { kind: 'addition', newLine: 3, text: 'tail' },
      ],
    }],
  }])
})

test('recognizes binary changes, pure renames, and empty patches', () => {
  assert.deepEqual(parseGitReviewPatch(''), [])
  assert.deepEqual(parseGitReviewPatch([
    'diff --git a/image.png b/image.png',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    'Binary files a/image.png and b/image.png differ',
    '',
  ].join('\n'))[0], {
    path: 'image.png',
    oldBlob: '1111111111111111111111111111111111111111',
    newBlob: '2222222222222222222222222222222222222222',
    binary: true,
    hunks: [],
  })
  assert.deepEqual(parseGitReviewPatch([
    'diff --git a/old-name.ts b/new-name.ts',
    'similarity index 100%',
    'rename from old-name.ts',
    'rename to new-name.ts',
    '',
  ].join('\n')), [{
    path: 'new-name.ts',
    oldPath: 'old-name.ts',
    binary: false,
    hunks: [],
  }])
})

test('classifies immutable blob and line anchors against the current review', () => {
  const files = parseGitReviewPatch([
    'diff --git a/example.ts b/example.ts',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    '--- a/example.ts',
    '+++ b/example.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n'))
  const anchor: GitReviewCommentAnchor = {
    path: 'example.ts',
    side: 'new',
    line: 1,
    blob: '2222222222222222222222222222222222222222',
  }
  assert.equal(classifyGitReviewAnchor(files, anchor), 'active')
  assert.equal(classifyGitReviewAnchor(files, { ...anchor, blob: '3'.repeat(40) }), 'stale')
  assert.equal(classifyGitReviewAnchor(files, { ...anchor, path: 'other.ts' }), 'out-of-scope')
})
