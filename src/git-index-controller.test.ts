import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  DesktopGitIndexMutationInput,
  GitIndexMutationParams,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  GitIndexController,
  GitIndexControllerError,
  type GitIndexWorkspace,
  selectGitIndexMutationPaths,
} from './git-index-controller'
import { GitMutationJournal, gitMutationPhase } from './git-mutation-journal'
import { writeJsonAtomically } from './atomic-json'

const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
const request: DesktopGitIndexMutationInput = {
  sessionId: 'session-1',
  workspaceRoot: '/repo',
  requestId: '11111111-1111-4111-8111-111111111111',
  kind: 'stage',
  paths: ['src/example.ts'],
}

function status(entries: GitStatusSnapshot['entries']): GitStatusSnapshot {
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

const unstaged = status([{
  kind: 'ordinary',
  path: 'src/example.ts',
  indexStatus: '.',
  worktreeStatus: 'M',
}])
const staged = status([{
  kind: 'ordinary',
  path: 'src/example.ts',
  indexStatus: 'M',
  worktreeStatus: '.',
}])

async function fixture(git: GitIndexWorkspace) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-index-controller-test-'))
  const journal = new GitMutationJournal(join(root, 'journal.json'))
  return { root, journal, controller: new GitIndexController(git, journal) }
}

test('selects only current status entries and expands both sides of a rename', () => {
  const snapshot = status([{
    kind: 'renamed',
    path: 'new name.ts',
    originalPath: 'old name.ts',
    indexStatus: 'R',
    worktreeStatus: 'M',
  }, {
    kind: 'unmerged',
    path: 'conflict.ts',
    indexStatus: 'U',
    worktreeStatus: 'U',
  }])
  assert.deepEqual(selectGitIndexMutationPaths(snapshot, 'stage', ['new name.ts']), [
    'new name.ts',
    'old name.ts',
  ])
  assert.deepEqual(selectGitIndexMutationPaths(snapshot, 'unstage', ['new name.ts']), [
    'new name.ts',
    'old name.ts',
  ])
  assert.throws(() => selectGitIndexMutationPaths(snapshot, 'unstage', ['conflict.ts']),
    (error: GitIndexControllerError) => error.code === 'CONFLICT')
})

test('persists intent and dispatch, then returns a successful retry without replay', async t => {
  let mutationCalls = 0
  const mutationInputs: GitIndexMutationParams[] = []
  const git: GitIndexWorkspace = {
    discover: async () => repository,
    status: async () => mutationCalls === 0 ? unstaged : staged,
    mutateIndex: async input => {
      mutationCalls += 1
      mutationInputs.push(input)
      return staged
    },
  }
  const { root, journal, controller } = await fixture(git)
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal

  assert.equal((await controller.mutate(request, signal)).status.entries[0]?.indexStatus, 'M')
  assert.equal((await controller.mutate(request, signal)).status.entries[0]?.indexStatus, 'M')
  assert.equal(mutationCalls, 1)
  assert.deepEqual(mutationInputs[0]?.paths, ['src/example.ts'])
  const record = journal.get(request.requestId)!
  assert.equal(gitMutationPhase(record), 'succeeded')
  assert.deepEqual(record.requestedPaths, request.paths)
  assert.deepEqual(record.events.map(event => event.phase), ['intent', 'dispatch', 'succeeded'])
})

test('rejects a stale selection before writing intent or changing the index', async t => {
  let mutationCalls = 0
  const git: GitIndexWorkspace = {
    discover: async () => repository,
    status: async () => status([]),
    mutateIndex: async () => {
      mutationCalls += 1
      return status([])
    },
  }
  const { root, journal, controller } = await fixture(git)
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(controller.mutate(request, new AbortController().signal),
    (error: GitIndexControllerError) => error.code === 'CONFLICT')
  assert.equal(mutationCalls, 0)
  assert.equal(journal.get(request.requestId), undefined)
})

test('marks a dispatched failure ambiguous and never replays it', async t => {
  let mutationCalls = 0
  const git: GitIndexWorkspace = {
    discover: async () => repository,
    status: async () => unstaged,
    mutateIndex: async () => {
      mutationCalls += 1
      throw new Error('unknown result')
    },
  }
  const { root, journal, controller } = await fixture(git)
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal

  await assert.rejects(controller.mutate(request, signal),
    (error: GitIndexControllerError) => error.code === 'CONFLICT' && /ambiguous/i.test(error.message))
  assert.equal(gitMutationPhase(journal.get(request.requestId)!), 'ambiguous')
  await assert.rejects(controller.mutate(request, signal),
    (error: GitIndexControllerError) => error.code === 'DUPLICATE_REQUEST')
  assert.equal(mutationCalls, 1)
})

test('reports an ambiguous result when Git succeeds but outcome persistence fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-index-outcome-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let writes = 0
  const journal = new GitMutationJournal(join(root, 'journal.json'), {
    write: (path, value) => {
      writes += 1
      if (writes === 3) throw new Error('disk full')
      writeJsonAtomically(path, value)
    },
  })
  let mutationCalls = 0
  const controller = new GitIndexController({
    discover: async () => repository,
    status: async () => unstaged,
    mutateIndex: async () => {
      mutationCalls += 1
      return staged
    },
  }, journal)

  await assert.rejects(controller.mutate(request, new AbortController().signal),
    (error: GitIndexControllerError) => error.code === 'CONFLICT' && /durable outcome/i.test(error.message))
  assert.equal(mutationCalls, 1)
  assert.equal(journal.status().available, false)
})

test('serializes different operations against one repository', async t => {
  let active = 0
  let maxActive = 0
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
  const order: string[] = []
  const git: GitIndexWorkspace = {
    discover: async () => repository,
    status: async () => status([{
      kind: 'ordinary',
      path: 'src/example.ts',
      indexStatus: '.',
      worktreeStatus: 'M',
    }, {
      kind: 'ordinary',
      path: 'src/second.ts',
      indexStatus: '.',
      worktreeStatus: 'M',
    }]),
    mutateIndex: async input => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(`start:${input.paths[0]}`)
      if (input.paths[0] === 'src/example.ts') await firstBlocked
      order.push(`end:${input.paths[0]}`)
      active -= 1
      return staged
    },
  }
  const { root, controller } = await fixture(git)
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  const first = controller.mutate(request, signal)
  const second = controller.mutate({
    ...request,
    requestId: '22222222-2222-4222-8222-222222222222',
    paths: ['src/second.ts'],
  }, signal)
  await new Promise(resolve => setImmediate(resolve))
  releaseFirst!()
  await Promise.all([first, second])

  assert.equal(maxActive, 1)
  assert.deepEqual(order, [
    'start:src/example.ts',
    'end:src/example.ts',
    'start:src/second.ts',
    'end:src/second.ts',
  ])
})
