import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { GitReviewSnapshot, GitStatusSnapshot } from '@dolphinminer/dsh-desktop-protocol'

import { writeJsonAtomically } from './atomic-json'
import {
  GitCommitController,
  GitCommitControllerError,
  type GitCommitWorkspace,
} from './git-commit-controller'
import { GitMutationJournal, gitMutationPhase } from './git-mutation-journal'

const previewId = '11111111-1111-4111-8111-111111111111'
const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }
const head = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const commit = 'c'.repeat(40)

function review(replacement = 'new'): GitReviewSnapshot {
  return {
    repository,
    scope: { kind: 'staged' },
    head,
    files: [{ status: 'modified', path: 'src/example.ts', patchAvailable: true }],
    patch: [
      'diff --git a/src/example.ts b/src/example.ts',
      `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-old',
      `+${replacement}`,
      '',
    ].join('\n'),
  }
}

function status(currentHead: string | undefined = head): GitStatusSnapshot {
  return {
    repository,
    ...(currentHead === undefined ? {} : { head: currentHead }),
    branch: 'main',
    ahead: 0,
    behind: 0,
    clean: true,
    entries: [],
  }
}

function successfulWorkspace(overrides: Partial<GitCommitWorkspace> = {}): GitCommitWorkspace {
  return {
    discover: async () => repository,
    review: async () => review(),
    status: async () => status(commit),
    indexTree: async () => tree,
    commit: async input => ({ operationId: input.operationId, commit, status: status(commit) }),
    ...overrides,
  }
}

async function fixture(
  git: GitCommitWorkspace,
  options: ConstructorParameters<typeof GitCommitController>[3] = {},
  journal?: GitMutationJournal,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-commit-controller-test-'))
  const mutations = journal ?? new GitMutationJournal(join(root, 'journal.json'))
  return {
    root,
    journal: mutations,
    controller: new GitCommitController(git, mutations, undefined, options),
  }
}

test('commits one exact staged preview and returns a successful retry without replay', async t => {
  let commitCalls = 0
  const git = successfulWorkspace({
    commit: async input => {
      commitCalls += 1
      assert.equal(input.expectedHead, head)
      assert.equal(input.expectedTree, tree)
      assert.equal(input.message, 'feat: exact staged state')
      return { operationId: input.operationId, commit, status: status(commit) }
    },
  })
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal

  const preview = await controller.preview(workspace, signal)
  assert.equal(preview.previewId, previewId)
  const input = { ...workspace, previewId, message: 'feat: exact staged state', confirmed: true as const }
  assert.equal((await controller.confirm(input, signal)).commit, commit)
  assert.equal((await controller.confirm(input, signal)).commit, commit)
  assert.equal(commitCalls, 1)
  const record = journal.get(previewId)!
  assert.equal(gitMutationPhase(record), 'succeeded')
  assert.equal(record.commit?.message, input.message)
  assert.equal(record.commit?.expectedTree, tree)
  assert.equal(record.resultCommit, commit)
})

test('rejects a staged patch change before persisting commit intent', async t => {
  let replacement = 'first'
  let commitCalls = 0
  const git = successfulWorkspace({
    review: async () => review(replacement),
    commit: async input => {
      commitCalls += 1
      return { operationId: input.operationId, commit, status: status(commit) }
    },
  })
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)
  replacement = 'second'

  await assert.rejects(controller.confirm({
    ...workspace,
    previewId,
    message: 'feat: stale',
    confirmed: true,
  }, signal), (error: GitCommitControllerError) => error.code === 'CONFLICT' && /changed after preview/i.test(error.message))
  assert.equal(journal.get(previewId), undefined)
  assert.equal(commitCalls, 0)
})

test('rejects an index that changes while the staged preview is being read', async t => {
  let treeReads = 0
  const git = successfulWorkspace({
    indexTree: async () => treeReads++ === 0 ? tree : 'd'.repeat(40),
  })
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(controller.preview(workspace, new AbortController().signal),
    (error: GitCommitControllerError) => error.code === 'CONFLICT' && /while creating/i.test(error.message))
  assert.equal(journal.get(previewId), undefined)
})

test('records a rejected hook as failed only when authoritative HEAD is unchanged', async t => {
  let commitCalls = 0
  const rejected = Object.assign(new Error('Git failed: review hook rejected'), { code: 'CONFLICT' as const })
  const git = successfulWorkspace({
    status: async () => status(head),
    commit: async () => {
      commitCalls += 1
      throw rejected
    },
  })
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)
  const input = { ...workspace, previewId, message: 'feat: rejected', confirmed: true as const }

  await assert.rejects(controller.confirm(input, signal),
    (error: GitCommitControllerError) => error.code === 'CONFLICT' && /hook rejected/i.test(error.message))
  assert.equal(gitMutationPhase(journal.get(previewId)!), 'failed')
  await assert.rejects(controller.confirm(input, signal),
    (error: GitCommitControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(commitCalls, 1)
})

test('marks an uncertain failure ambiguous and never replays it', async t => {
  let commitCalls = 0
  const git = successfulWorkspace({
    commit: async () => {
      commitCalls += 1
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' as const })
    },
  })
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)
  const input = { ...workspace, previewId, message: 'feat: uncertain', confirmed: true as const }

  await assert.rejects(controller.confirm(input, signal),
    (error: GitCommitControllerError) => error.code === 'CONFLICT' && /ambiguous/i.test(error.message))
  assert.equal(gitMutationPhase(journal.get(previewId)!), 'ambiguous')
  await assert.rejects(controller.confirm(input, signal),
    (error: GitCommitControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(commitCalls, 1)
})

test('expires a preview before writing durable intent', async t => {
  let current = Date.parse('2026-08-16T12:00:00.000Z')
  const { root, journal, controller } = await fixture(successfulWorkspace(), {
    now: () => new Date(current),
    randomId: () => previewId,
    previewTtlMs: 1_000,
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)
  current += 1_001

  await assert.rejects(controller.confirm({
    ...workspace,
    previewId,
    message: 'feat: expired',
    confirmed: true,
  }, signal), (error: GitCommitControllerError) => error.code === 'CONFLICT' && /expired/i.test(error.message))
  assert.equal(journal.get(previewId), undefined)
})

test('reports a created commit as ambiguous when its durable outcome cannot be recorded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-commit-outcome-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let writes = 0
  const journal = new GitMutationJournal(join(root, 'journal.json'), {
    write: (path, value) => {
      writes += 1
      if (writes === 3) throw new Error('disk full')
      writeJsonAtomically(path, value)
    },
  })
  const controller = new GitCommitController(successfulWorkspace(), journal, undefined, {
    randomId: () => previewId,
  })
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)

  await assert.rejects(controller.confirm({
    ...workspace,
    previewId,
    message: 'feat: durable outcome',
    confirmed: true,
  }, signal), (error: GitCommitControllerError) => /created commit/.test(error.message))
  assert.equal(journal.status().available, false)
})
