import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitRepositoryIdentity, GitStatusSnapshot } from '@dolphinminer/dsh-desktop-protocol'

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

test('authorizes both sides of workspace-bound discovery and status', async () => {
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
  }
  const service = new WorkspaceGitCapabilityService(git, (sessionId, workspaceRoot, signal) => {
    assert.equal(signal.aborted, false)
    calls.push(`authorize:${sessionId}:${workspaceRoot}`)
  })
  const params = { sessionId: 'session-1', workspaceRoot: '/repo' }
  const signal = new AbortController().signal

  assert.deepEqual(await service.discover(params, signal), repository)
  assert.equal((await service.status({ ...params, repositoryRoot: '/repo' }, signal)).clean, true)
  assert.deepEqual(calls, [
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'authorize:session-1:/repo',
    'discover:/repo',
    'authorize:session-1:/repo',
    'status:/repo',
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
  }, () => undefined)

  await assert.rejects(service.status({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    repositoryRoot: '/repo',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'CONFLICT')
})

test('maps bounded Git failures without weakening caller authorization', async () => {
  let authorized = false
  const service = new WorkspaceGitCapabilityService({
    discoverRepository: async () => {
      throw new GitServiceError('NOT_REPOSITORY', 'No repository was found.')
    },
    status: async () => cleanStatus(),
  }, () => {
    authorized = true
  })

  await assert.rejects(service.discover({
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  }, new AbortController().signal), (error: WorkspaceGitError) => error.code === 'NOT_FOUND')
  assert.equal(authorized, true)
})
