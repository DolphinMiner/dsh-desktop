import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  GitRepositoryIdentity,
  GitReviewSnapshot,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitServiceError } from './git-service'
import {
  GitRepositoryOperations,
  WorkspaceGitCapabilityService,
  WorkspaceGitError,
} from './workspace-git'

const repository: GitRepositoryIdentity = {
  root: '/repo',
  gitDir: '/repo/.git',
  commonDir: '/repo/.git',
}

function cleanStatus(identity: GitRepositoryIdentity = repository): GitStatusSnapshot {
  return {
    repository: identity,
    head: 'a'.repeat(40),
    branch: 'main',
    ahead: 0,
    behind: 0,
    clean: true,
    entries: [],
  }
}

function emptyReview(identity: GitRepositoryIdentity = repository): GitReviewSnapshot {
  return {
    repository: identity,
    scope: { kind: 'unstaged' },
    head: 'a'.repeat(40),
    files: [],
    patch: '',
  }
}

test('authorizes both sides of workspace-bound Git reads', async () => {
  const calls: string[] = []
  const git: GitRepositoryOperations = {
    discoverRepository: async path => {
      calls.push(`discover:${path}`)
      return repository
    },
    status: async root => {
      calls.push(`status:${root}`)
      return cleanStatus()
    },
    review: async (root, scope) => {
      calls.push(`review:${root}:${scope.kind}`)
      return emptyReview()
    },
    mutateIndex: async (root, kind, paths) => {
      calls.push(`mutate:${root}:${kind}:${paths.join(',')}`)
      return cleanStatus()
    },
  }
  const service = new WorkspaceGitCapabilityService(git, (sessionId, workspaceRoot, signal) => {
    assert.equal(signal.aborted, false)
    calls.push(`authorize:${sessionId}:${workspaceRoot}`)
  })
  const params = { sessionId: 'session-1', workspaceRoot: '/repo' }
  const signal = new AbortController().signal

  assert.deepEqual(await service.discover(params, signal), repository)
  assert.equal((await service.status({ ...params, repositoryRoot: '/repo' }, signal)).clean, true)
  assert.equal((await service.review({
    ...params,
    repositoryRoot: '/repo',
    scope: { kind: 'unstaged' },
  }, signal)).patch, '')
  assert.equal((await service.mutateIndex({
    ...params,
    repositoryRoot: '/repo',
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'stage',
    paths: ['src/example.ts'],
  }, signal)).clean, true)
  assert.deepEqual(calls, [
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'status:/repo',
    'authorize:session-1:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'review:/repo:unstaged',
    'authorize:session-1:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'mutate:/repo:stage:src/example.ts',
    'authorize:session-1:/repo',
  ])
})

test('rejects an unrelated requested root before reading status', async () => {
  let statusCalls = 0
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => repository,
    status: async () => {
      statusCalls += 1
      return cleanStatus()
    },
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
  }, () => undefined)

  await assert.rejects(service.status({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/other',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'BAD_MESSAGE')
  assert.equal(statusCalls, 0)
})

test('rejects a repository identity that changes during status', async () => {
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => repository,
    status: async () => cleanStatus({ ...repository, gitDir: '/repo/.git-replaced' }),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
  }, () => undefined)

  await assert.rejects(service.status({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'CONFLICT')
})

test('rejects a repository identity that changes during review', async () => {
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => repository,
    status: async () => cleanStatus(),
    review: async () => emptyReview({ ...repository, commonDir: '/repo/.git-replaced' }),
    mutateIndex: async () => cleanStatus(),
  }, () => undefined)

  await assert.rejects(service.review({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
    scope: { kind: 'unstaged' },
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'CONFLICT')
})

test('rejects a repository identity that changes during an index mutation', async () => {
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => repository,
    status: async () => cleanStatus(),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus({ ...repository, commonDir: '/repo/.git-replaced' }),
  }, () => undefined)

  await assert.rejects(service.mutateIndex({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'stage',
    paths: ['src/example.ts'],
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'CONFLICT')
})

test('maps bounded Git failures without weakening caller authorization', async () => {
  let authorized = false
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => {
      throw new GitServiceError('NOT_REPOSITORY', 'No repository was found.')
    },
    status: async () => cleanStatus(),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
  }, () => {
    authorized = true
  })

  await assert.rejects(service.discover({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'NOT_FOUND')
  assert.equal(authorized, true)
})
