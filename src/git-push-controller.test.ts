import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { GitPushState } from '@dolphinminer/dsh-desktop-protocol'

import { writeJsonAtomically } from './atomic-json'
import {
  GitPushController,
  GitPushControllerError,
  type GitPushWorkspace,
} from './git-push-controller'
import { GitMutationJournal, gitMutationPhase, type GitMutationJournalOptions } from './git-mutation-journal'

const previewId = '11111111-1111-4111-8111-111111111111'
const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }

function pushState(overrides: Partial<GitPushState> = {}): GitPushState {
  return {
    remote: 'origin',
    remoteUrl: 'https://github.com/example/repo.git',
    remoteUrlFingerprint: 'f'.repeat(64),
    localBranch: 'feature/review',
    localRef: 'refs/heads/feature/review',
    remoteRef: 'refs/heads/feature/review',
    trackingRef: 'refs/remotes/origin/feature/review',
    head: 'b'.repeat(40),
    upstreamHead: 'a'.repeat(40),
    ahead: 2,
    behind: 0,
    ...overrides,
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

async function fixture(
  git: GitPushWorkspace,
  options: ConstructorParameters<typeof GitPushController>[3] = {},
  journalOptions: GitMutationJournalOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-push-controller-test-'))
  const journal = new GitMutationJournal(join(root, 'journal.json'), journalOptions)
  return {
    root,
    journal,
    controller: new GitPushController(git, journal, undefined, {
      approve: async () => true,
      ...options,
    }),
  }
}

test('binds Push to an exact approved target and never replays a successful operation', async t => {
  let current = pushState()
  let pushCalls = 0
  let approvedTarget: object | undefined
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => ({ ...current }),
    push: async input => {
      pushCalls += 1
      assert.deepEqual(input.target, pushState())
      current = pushState({ upstreamHead: input.target.head, ahead: 0 })
      return {
        operationId: input.operationId,
        remote: input.target.remote,
        remoteRef: input.target.remoteRef,
        head: input.target.head,
      }
    },
  }
  const { root, journal, controller } = await fixture(git, {
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    randomId: () => previewId,
    approve: async details => {
      approvedTarget = details.target
      return true
    },
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal

  const preview = await controller.preview(workspace, signal)
  assert.equal(preview.previewId, previewId)
  assert.equal(preview.expiresAt, '2026-08-16T12:05:00.000Z')
  assert.equal('remoteUrlFingerprint' in preview.target, false)
  const first = await controller.confirm({ ...workspace, previewId, confirmed: true }, signal)
  const duplicate = await controller.confirm({ ...workspace, previewId, confirmed: true }, signal)
  assert.deepEqual(duplicate, first)
  assert.equal(pushCalls, 1)
  assert.equal('remoteUrlFingerprint' in (approvedTarget ?? {}), false)
  const record = journal.get(previewId)!
  assert.equal(record.kind, 'push')
  assert.deepEqual(record.push, pushState())
  assert.match(record.approval?.fingerprint ?? '', /^[a-f0-9]{64}$/)
  assert.equal(gitMutationPhase(record), 'succeeded')
})

test('rejects a preview when there is nothing safe to push', async t => {
  let current = pushState({ upstreamHead: 'b'.repeat(40), ahead: 0 })
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => current,
    push: async () => { throw new Error('must not push') },
  }
  const { root, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(controller.preview(workspace, new AbortController().signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /no local commits/i.test(error.message))

  current = pushState({ behind: 1 })
  await assert.rejects(controller.preview(workspace, new AbortController().signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /remote branch is ahead/i.test(error.message))
})

test('expires or rejects native approval without persisting Push intent', async t => {
  let currentTime = Date.parse('2026-08-16T12:00:00.000Z')
  let pushCalls = 0
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => pushState(),
    push: async () => {
      pushCalls += 1
      throw new Error('must not push')
    },
  }
  const first = await fixture(git, {
    now: () => new Date(currentTime),
    randomId: () => previewId,
    previewTtlMs: 1_000,
  })
  t.after(() => rm(first.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await first.controller.preview(workspace, signal)
  currentTime += 1_001
  await assert.rejects(first.controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /expired/i.test(error.message))
  assert.equal(first.journal.get(previewId), undefined)

  const second = await fixture(git, { randomId: () => previewId, approve: async () => false })
  t.after(() => rm(second.root, { recursive: true, force: true }))
  await second.controller.preview(workspace, signal)
  await assert.rejects(second.controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CANCELLED')
  assert.equal(second.journal.get(previewId), undefined)
  assert.equal(pushCalls, 0)
})

test('revalidates target state both before and after native approval', async t => {
  let current = pushState()
  let approvals = 0
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => ({ ...current }),
    push: async () => { throw new Error('must not push') },
  }
  const first = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(first.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await first.controller.preview(workspace, signal)
  current = pushState({ head: 'c'.repeat(40), ahead: 3 })
  await assert.rejects(first.controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /changed after preview/i.test(error.message))

  current = pushState()
  const second = await fixture(git, {
    randomId: () => previewId,
    approve: async () => {
      approvals += 1
      current = pushState({ remoteUrlFingerprint: 'e'.repeat(64) })
      return true
    },
  })
  t.after(() => rm(second.root, { recursive: true, force: true }))
  await second.controller.preview(workspace, signal)
  await assert.rejects(second.controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /changed during approval/i.test(error.message))
  assert.equal(approvals, 1)
  assert.equal(second.journal.get(previewId), undefined)
})

test('records a clear Git rejection only when the live remote is still unchanged', async t => {
  let pushCalls = 0
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => pushState(),
    push: async () => {
      pushCalls += 1
      throw codedError('CONFLICT', 'The pre-push hook rejected this Push.')
    },
  }
  const { root, journal, controller } = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /hook rejected/i.test(error.message))
  assert.equal(gitMutationPhase(journal.get(previewId)!), 'failed')
  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(pushCalls, 1)
})

test('never retries timeout or changed-remote results and reconciles only an exact remote success', async t => {
  let current = pushState()
  let mode: 'unchanged' | 'changed' | 'succeeded' = 'unchanged'
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => ({ ...current }),
    push: async () => {
      if (mode === 'changed') current = pushState({ upstreamHead: 'c'.repeat(40), behind: 1 })
      if (mode === 'succeeded') current = pushState({ upstreamHead: 'b'.repeat(40), ahead: 0 })
      throw codedError('TIMEOUT', 'Push timed out.')
    },
  }
  const signal = new AbortController().signal

  const unchanged = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(unchanged.root, { recursive: true, force: true }))
  await unchanged.controller.preview(workspace, signal)
  await assert.rejects(unchanged.controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /ambiguous/i.test(error.message))
  assert.equal(gitMutationPhase(unchanged.journal.get(previewId)!), 'ambiguous')

  mode = 'changed'
  current = pushState()
  const changed = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(changed.root, { recursive: true, force: true }))
  await changed.controller.preview(workspace, signal)
  await assert.rejects(changed.controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /ambiguous/i.test(error.message))
  assert.equal(gitMutationPhase(changed.journal.get(previewId)!), 'ambiguous')

  mode = 'succeeded'
  current = pushState()
  const succeeded = await fixture(git, { randomId: () => previewId })
  t.after(() => rm(succeeded.root, { recursive: true, force: true }))
  await succeeded.controller.preview(workspace, signal)
  assert.equal((await succeeded.controller.confirm({ ...workspace, previewId, confirmed: true }, signal)).head,
    'b'.repeat(40))
  assert.equal(gitMutationPhase(succeeded.journal.get(previewId)!), 'succeeded')
})

test('reports a pushed commit when durable success persistence fails and leaves it non-replayable', async t => {
  let writes = 0
  const git: GitPushWorkspace = {
    discover: async () => repository,
    pushTarget: async () => pushState(),
    push: async input => ({
      operationId: input.operationId,
      remote: input.target.remote,
      remoteRef: input.target.remoteRef,
      head: input.target.head,
    }),
  }
  const { root, controller } = await fixture(git, { randomId: () => previewId }, {
    write: (path, value) => {
      writes += 1
      if (writes === 3) throw new Error('disk full')
      writeJsonAtomically(path, value)
    },
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await controller.preview(workspace, signal)

  await assert.rejects(controller.confirm({ ...workspace, previewId, confirmed: true }, signal),
    (error: GitPushControllerError) => error.code === 'CONFLICT' && /durable outcome/i.test(error.message))
})
