import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { GitReviewSnapshot, GitStatusSnapshot } from '@dolphinminer/dsh-desktop-protocol'

import {
  GitRevertController,
  GitRevertControllerError,
  type GitRevertWorkspace,
} from './git-revert-controller'
import { GitMutationJournal, gitMutationPhase } from './git-mutation-journal'

const previewId = '11111111-1111-4111-8111-111111111111'
const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }
const path = 'src/example.ts'

function review(replacement = 'new'): GitReviewSnapshot {
  return {
    repository,
    scope: { kind: 'unstaged' },
    head: 'a'.repeat(40),
    files: [{ status: 'modified', path, patchAvailable: true }],
    patch: [
      `diff --git a/${path} b/${path}`,
      `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      '-old',
      `+${replacement}`,
      '',
    ].join('\n'),
  }
}

function status(entries: GitStatusSnapshot['entries'] = []): GitStatusSnapshot {
  return {
    repository,
    head: 'a'.repeat(40),
    branch: 'main',
    ahead: 0,
    behind: 0,
    clean: entries.length === 0,
    entries,
  }
}

async function fixture(
  git: GitRevertWorkspace,
  options: ConstructorParameters<typeof GitRevertController>[3] = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-revert-controller-test-'))
  const journal = new GitMutationJournal(join(root, 'journal.json'))
  return {
    root,
    journal,
    controller: new GitRevertController(git, journal, undefined, {
      approve: async () => true,
      ...options,
    }),
  }
}

test('binds an explicit preview to the exact review and never replays a successful revert', async t => {
  let revertCalls = 0
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => review(),
    status: async () => status(),
    revertWorktree: async input => {
      revertCalls += 1
      assert.equal(input.path, path)
      return status()
    },
  }
  const { root, journal, controller } = await fixture(git, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal

  const preview = await controller.preview({ ...workspace, path }, signal)
  assert.equal(preview.previewId, previewId)
  assert.equal(preview.expiresAt, '2026-08-16T12:05:00.000Z')
  assert.equal((await controller.confirm({ ...workspace, previewId, confirmed: true }, signal)).status.clean, true)
  assert.equal((await controller.confirm({ ...workspace, previewId, confirmed: true }, signal)).status.clean, true)
  assert.equal(revertCalls, 1)
  const record = journal.get(previewId)!
  assert.equal(record.kind, 'revert')
  assert.equal(record.approval?.id, previewId)
  assert.match(record.approval?.fingerprint ?? '', /^[a-f0-9]{64}$/)
  assert.equal(gitMutationPhase(record), 'succeeded')
})

test('rejects approval when the reviewed content changes before confirmation', async t => {
  let revision = 'first'
  let revertCalls = 0
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => review(revision),
    status: async () => status(),
    revertWorktree: async () => {
      revertCalls += 1
      return status()
    },
  }
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview({ ...workspace, path }, signal)
  revision = 'second'

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitRevertControllerError) => error.code === 'CONFLICT' && /changed after approval/i.test(error.message))
  assert.equal(revertCalls, 0)
  assert.equal(journal.get(previewId), undefined)
})

test('expires a preview without creating durable mutation intent', async t => {
  let current = Date.parse('2026-08-16T12:00:00.000Z')
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => review(),
    status: async () => status(),
    revertWorktree: async () => status(),
  }
  const { root, journal, controller } = await fixture(git, {
    now: () => new Date(current),
    randomId: () => previewId,
    previewTtlMs: 1_000,
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview({ ...workspace, path }, signal)
  current += 1_001

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitRevertControllerError) => error.code === 'CONFLICT' && /expired/i.test(error.message))
  assert.equal(journal.get(previewId), undefined)
})

test('requires a main-process approval before persisting or dispatching revert intent', async t => {
  let revertCalls = 0
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => review(),
    status: async () => status(),
    revertWorktree: async () => {
      revertCalls += 1
      return status()
    },
  }
  const { root, journal, controller } = await fixture(git, {
    randomId: () => previewId,
    approve: async () => false,
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview({ ...workspace, path }, signal)

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitRevertControllerError) => error.code === 'CANCELLED')
  assert.equal(revertCalls, 0)
  assert.equal(journal.get(previewId), undefined)
})

test('revalidates the review after the main-process approval returns', async t => {
  let revision = 'first'
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => review(revision),
    status: async () => status(),
    revertWorktree: async () => status(),
  }
  const { root, journal, controller } = await fixture(git, {
    randomId: () => previewId,
    approve: async () => {
      revision = 'changed while approving'
      return true
    },
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview({ ...workspace, path }, signal)

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitRevertControllerError) => error.code === 'CONFLICT' && /during approval/i.test(error.message))
  assert.equal(journal.get(previewId), undefined)
})

test('refuses untracked and conflict changes because their content is not safely previewed', async t => {
  let snapshot: GitReviewSnapshot = {
    ...review(),
    files: [{ status: 'untracked', path, patchAvailable: false }],
    patch: '',
  }
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => snapshot,
    status: async () => status(),
    revertWorktree: async () => status(),
  }
  const { root, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await assert.rejects(controller.preview({ ...workspace, path }, signal),
    (error: GitRevertControllerError) => error.code === 'BAD_MESSAGE')

  snapshot = { ...review(), files: [{ status: 'unmerged', path, patchAvailable: true }] }
  await assert.rejects(controller.preview({ ...workspace, path }, signal),
    (error: GitRevertControllerError) => error.code === 'BAD_MESSAGE')
})

test('records a dispatched revert failure as ambiguous and blocks confirmation replay', async t => {
  let revertCalls = 0
  const git: GitRevertWorkspace = {
    discover: async () => repository,
    review: async () => review(),
    status: async () => status(),
    revertWorktree: async () => {
      revertCalls += 1
      throw new Error('unknown result')
    },
  }
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview({ ...workspace, path }, signal)

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitRevertControllerError) => error.code === 'CONFLICT' && /ambiguous/i.test(error.message))
  assert.equal(gitMutationPhase(journal.get(previewId)!), 'ambiguous')
  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitRevertControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(revertCalls, 1)
})
