import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  GitPushState,
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

const pushTarget: GitPushState = {
  remote: 'origin',
  remoteUrl: 'https://github.com/example/repo.git',
  remoteUrlFingerprint: 'f'.repeat(64),
  localBranch: 'main',
  localRef: 'refs/heads/main',
  remoteRef: 'refs/heads/main',
  trackingRef: 'refs/remotes/origin/main',
  head: 'b'.repeat(40),
  upstreamHead: 'a'.repeat(40),
  ahead: 1,
  behind: 0,
}

const pushResult = { remote: 'origin', remoteRef: 'refs/heads/main', head: 'b'.repeat(40) }

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

function committedStatus(identity: GitRepositoryIdentity = repository): GitStatusSnapshot {
  return { ...cleanStatus(identity), head: 'b'.repeat(40) }
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
    revertWorktree: async (root, path) => {
      calls.push(`revert:${root}:${path}`)
      return cleanStatus()
    },
    indexTree: async root => {
      calls.push(`tree:${root}`)
      return 'c'.repeat(40)
    },
    commit: async (root, message, expectedHead, expectedTree) => {
      calls.push(`commit:${root}:${message}:${expectedHead ?? 'initial'}:${expectedTree}`)
      return { commit: 'b'.repeat(40), status: committedStatus() }
    },
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
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
  assert.equal((await service.revertWorktree({
    ...params,
    repositoryRoot: '/repo',
    operationId: '22222222-2222-4222-8222-222222222222',
    path: 'src/example.ts',
  }, signal)).clean, true)
  assert.equal(await service.indexTree({ ...params, repositoryRoot: '/repo' }, signal), 'c'.repeat(40))
  assert.equal((await service.commit({
    ...params,
    repositoryRoot: '/repo',
    operationId: '33333333-3333-4333-8333-333333333333',
    message: 'feat: test',
    expectedHead: 'a'.repeat(40),
    expectedTree: 'c'.repeat(40),
  }, signal)).commit, 'b'.repeat(40))
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
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'revert:/repo:src/example.ts',
    'authorize:session-1:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'tree:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    `commit:/repo:feat: test:${'a'.repeat(40)}:${'c'.repeat(40)}`,
    'authorize:session-1:/repo',
  ])
})

test('authorizes and revalidates repository identity around push target reads and writes', async () => {
  let authorizations = 0
  let discoveries = 0
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => {
      discoveries += 1
      return repository
    },
    status: async () => cleanStatus(),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
  }, () => { authorizations += 1 })
  const params = { sessionId: 'session-1', workspaceRoot: '/repo', repositoryRoot: '/repo' }
  const signal = new AbortController().signal

  assert.deepEqual(await service.pushTarget(params, signal), pushTarget)
  assert.deepEqual(await service.push({
    ...params,
    operationId: '44444444-4444-4444-8444-444444444444',
    target: pushTarget,
  }, signal), { operationId: '44444444-4444-4444-8444-444444444444', ...pushResult })
  assert.equal(discoveries, 4)
  assert.equal(authorizations, 8)
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
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
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
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
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
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
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
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
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

test('rejects a repository identity that changes during a worktree revert', async () => {
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => repository,
    status: async () => cleanStatus(),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
    revertWorktree: async () => cleanStatus({ ...repository, gitDir: '/repo/.git-replaced' }),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
  }, () => undefined)

  await assert.rejects(service.revertWorktree({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
    operationId: '22222222-2222-4222-8222-222222222222',
    path: 'src/example.ts',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'CONFLICT')
})

test('rejects repository identity changes during index-tree reads and commits', async () => {
  let discoveries = 0
  const indexService = new WorkspaceGitCapabilityService({
    discoverRepository: async () => discoveries++ === 0
      ? repository
      : { ...repository, gitDir: '/repo/.git-replaced' },
    status: async () => cleanStatus(),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
  }, () => undefined)
  await assert.rejects(indexService.indexTree({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'CONFLICT')

  const commitService = new WorkspaceGitCapabilityService({
    discoverRepository: async () => repository,
    status: async () => cleanStatus(),
    review: async () => emptyReview(),
    mutateIndex: async () => cleanStatus(),
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({
      commit: 'b'.repeat(40),
      status: committedStatus({ ...repository, commonDir: '/repo/.git-replaced' }),
    }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
  }, () => undefined)
  await assert.rejects(commitService.commit({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
    operationId: '33333333-3333-4333-8333-333333333333',
    message: 'feat: test',
    expectedHead: 'a'.repeat(40),
    expectedTree: 'c'.repeat(40),
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
    revertWorktree: async () => cleanStatus(),
    indexTree: async () => 'c'.repeat(40),
    commit: async () => ({ commit: 'b'.repeat(40), status: committedStatus() }),
    pushTarget: async () => pushTarget,
    push: async () => pushResult,
  }, () => {
    authorized = true
  })

  await assert.rejects(service.discover({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'NOT_FOUND')
  assert.equal(authorized, true)
})
