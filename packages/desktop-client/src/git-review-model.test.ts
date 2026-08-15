import assert from 'node:assert/strict'
import test from 'node:test'

import { parseGitReviewPatch } from './git-review-model.js'

test('parses Git patches into stable file, hunk, and line coordinates', () => {
  const files = parseGitReviewPatch([
    'diff --git a/src/example.ts b/src/example.ts',
    'index 1111111..2222222 100644',
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
    oldBlob: '1111111',
    newBlob: '2222222',
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

test('recognizes binary changes and empty patches without inventing hunks', () => {
  assert.deepEqual(parseGitReviewPatch(''), [])
  assert.deepEqual(parseGitReviewPatch([
    'diff --git a/image.png b/image.png',
    'index 1111111..2222222 100644',
    'Binary files a/image.png and b/image.png differ',
    '',
  ].join('\n')), [{
    path: 'image.png',
    oldBlob: '1111111',
    newBlob: '2222222',
    binary: true,
    hunks: [],
  }])
})

test('keeps both paths for a pure rename without inventing a textual hunk', () => {
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
