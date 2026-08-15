import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { GitReviewParams, GitReviewSnapshot } from '@dolphinminer/dsh-desktop-protocol'

import { GitReviewCommentController, type ReviewWorkspaceGit } from './git-review-comment-controller'
import { GitReviewCommentStore } from './git-review-comments'

const requestId = '11111111-1111-4111-8111-111111111111'
const blob = '2'.repeat(40)
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }
const repository = { root: '/canonical/repo', gitDir: '/canonical/repo/.git', commonDir: '/shared/.git' }
const patch = [
  'diff --git a/example.ts b/example.ts',
  `index ${'1'.repeat(40)}..${blob} 100644`,
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n')

async function fixture(reviewPatch = patch) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-controller-test-'))
  const calls: GitReviewParams[] = []
  const git: ReviewWorkspaceGit = {
    discover: async () => repository,
    review: async input => {
      calls.push(input)
      return {
        repository,
        scope: input.scope,
        head: '3'.repeat(40),
        files: [{ status: 'modified', path: 'example.ts', patchAvailable: true }],
        patch: reviewPatch,
      } satisfies GitReviewSnapshot
    },
  }
  const store = new GitReviewCommentStore(join(root, 'comments.json'), {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
  })
  return { root, calls, store, controller: new GitReviewCommentController(git, store) }
}

test('re-discovers the repository and persists only an anchor in the current patch', async t => {
  const { root, calls, controller } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  const result = await controller.add({
    ...workspace,
    requestId,
    scope: { kind: 'unstaged' },
    anchor: { path: 'example.ts', side: 'new', line: 1, blob },
    body: 'Keep this explicit.',
  }, signal)

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    ...workspace,
    repositoryRoot: repository.root,
    scope: { kind: 'unstaged' },
  })
  assert.equal(result.repositoryCommonDir, repository.commonDir)
  assert.equal(result.comments[0]?.body, 'Keep this explicit.')
  assert.deepEqual(await controller.list(workspace, signal), result)
})

test('rejects a changed blob before persistence', async t => {
  const { root, store, controller } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(() => controller.add({
    ...workspace,
    requestId,
    scope: { kind: 'unstaged' },
    anchor: { path: 'example.ts', side: 'new', line: 1, blob: '4'.repeat(40) },
    body: 'Must not persist.',
  }, new AbortController().signal), /review changed/i)
  assert.equal(store.snapshot(repository.commonDir).comments.length, 0)
})

test('removes comments only after resolving the caller repository', async t => {
  const { root, controller } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.add({
    ...workspace,
    requestId,
    scope: { kind: 'unstaged' },
    anchor: { path: 'example.ts', side: 'new', line: 1, blob },
    body: 'Remove me.',
  }, signal)
  const result = await controller.remove({ ...workspace, commentId: requestId }, signal)
  assert.deepEqual(result.comments, [])
})
