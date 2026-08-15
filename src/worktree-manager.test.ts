import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import type { GitRepositoryIdentity } from '@dolphinminer/dsh-desktop-protocol'

import { GitCreateWorktreeInput, GitService, GitServiceError } from './git-service'
import {
  ProvisionWorktreeInput,
  WorktreeGitOperations,
  WorktreeManager,
  WorktreeManagerError,
} from './worktree-manager'
import { WorktreeRegistry } from './worktree-registry'

const execFileAsync = promisify(execFile)

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  return result.stdout.trim()
}

async function repositoryFixture(parent: string): Promise<string> {
  const root = join(parent, 'repository')
  await mkdir(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'DSH Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(root, 'README.md'), 'base\n')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-m', 'initial')
  return root
}

function input(overrides: Partial<ProvisionWorktreeInput> = {}): ProvisionWorktreeInput {
  return {
    operationId: 'provision-1',
    requestedBySessionId: 'session-1',
    workspaceRoot: '/repo',
    baseRef: 'refs/heads/main',
    ...overrides,
  }
}

test('provisions locked isolated worktrees and preserves parallel checkout state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repositoryRoot = await repositoryFixture(root)
  const registry = new WorktreeRegistry(join(root, 'data', 'worktrees.v1.json'))
  const manager = new WorktreeManager(
    new GitService(),
    registry,
    join(root, 'managed-worktrees'),
    () => undefined,
  )
  const firstInput = input({ workspaceRoot: repositoryRoot })

  const firstResult = await manager.provision(firstInput, new AbortController().signal)
  const first = firstResult.record
  assert.equal(firstResult.created, true)
  assert.equal(first.lifecycle, 'ready')
  assert.equal(first.executionMode, 'worktree')
  assert.equal(await git(first.worktreePath!, 'rev-parse', 'HEAD'), first.baseCommit)
  assert.equal(await git(first.worktreePath!, 'symbolic-ref', 'HEAD'), first.branch)
  const porcelain = await git(repositoryRoot, 'worktree', 'list', '--porcelain')
  assert.match(porcelain, new RegExp(`worktree ${first.worktreePath!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(porcelain, /locked DSH Desktop session/)

  const bound = await manager.bindSession({
    sessionId: 'session-worktree-1',
    workspacePath: first.worktreePath!,
  }, new AbortController().signal)
  assert.equal(bound?.requestedBySessionId, 'session-1')
  assert.equal(bound?.sessionId, 'session-worktree-1')
  assert.equal(await manager.bindSession({
    sessionId: 'session-local',
    workspacePath: repositoryRoot,
  }, new AbortController().signal), undefined)
  const healthy = await manager.reconcile(new AbortController().signal)
  assert.equal(healthy.inspected, 1)
  assert.equal(healthy.healthy, 1)
  assert.equal(healthy.recoveryRequired, 0)

  await writeFile(join(first.worktreePath!, 'README.md'), 'session one\n')
  const duplicate = await manager.provision(firstInput, new AbortController().signal)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.record.id, first.id)
  assert.equal(await readFile(join(first.worktreePath!, 'README.md'), 'utf8'), 'session one\n')

  const second = (await manager.provision(input({
    operationId: 'provision-2',
    requestedBySessionId: 'session-2',
    workspaceRoot: repositoryRoot,
  }), new AbortController().signal)).record
  assert.notEqual(second.worktreePath, first.worktreePath)
  assert.equal(await readFile(join(second.worktreePath!, 'README.md'), 'utf8'), 'base\n')
  assert.equal(await readFile(join(repositoryRoot, 'README.md'), 'utf8'), 'base\n')

  await git(repositoryRoot, 'worktree', 'unlock', first.worktreePath!)
  const drifted = await manager.reconcile(new AbortController().signal)
  const firstAfterDrift = drifted.snapshot.worktrees.find(worktree => worktree.id === first.id)
  assert.equal(firstAfterDrift?.lifecycle, 'recovery-required')
  assert.equal(firstAfterDrift?.recoveryReason, 'locked')
})

test('does not dispatch a concurrent duplicate while creation is in flight', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-concurrent-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let releaseCreate: ((identity: GitRepositoryIdentity) => void) | undefined
  let signalStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
  let createCalls = 0
  const gitOperations: WorktreeGitOperations = {
    discoverRepository: async path => path === '/repo'
      ? repository
      : { root: path, gitDir: `${path}/.git`, commonDir: '/repo/.git' },
    resolveCommit: async () => 'a'.repeat(40),
    listWorktrees: async () => [],
    createWorktree: async request => {
      createCalls += 1
      signalStarted?.()
      return new Promise(resolve => {
        releaseCreate = () => resolve({
          root: request.worktreePath,
          gitDir: `${request.worktreePath}/.git`,
          commonDir: '/repo/.git',
        })
      })
    },
  }
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const manager = new WorktreeManager(gitOperations, registry, join(root, 'worktrees'), () => undefined)
  const params = input()

  const first = manager.provision(params, new AbortController().signal)
  await started
  await assert.rejects(manager.provision(params, new AbortController().signal),
    (error: WorktreeManagerError) => error.code === 'CONFLICT' && error.ambiguous)
  assert.equal(createCalls, 1)
  const record = registry.getByCreationOperation('provision-1')!
  releaseCreate?.({
    root: record.worktreePath!,
    gitDir: `${record.worktreePath!}/.git`,
    commonDir: '/repo/.git',
  })
  assert.equal((await first).record.lifecycle, 'ready')
})

test('persists an ambiguous create failure and never replays it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-ambiguous-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'registry.json')
  const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
  let createCalls = 0
  const operations: WorktreeGitOperations = {
    discoverRepository: async () => repository,
    resolveCommit: async () => 'a'.repeat(40),
    listWorktrees: async () => [],
    createWorktree: async (_request: GitCreateWorktreeInput) => {
      createCalls += 1
      throw new GitServiceError('TIMEOUT', 'Git worktree creation timed out.')
    },
  }
  const manager = new WorktreeManager(
    operations,
    new WorktreeRegistry(path),
    join(root, 'worktrees'),
    () => undefined,
  )

  await assert.rejects(manager.provision(input(), new AbortController().signal),
    (error: WorktreeManagerError) => error.code === 'TIMEOUT' && error.ambiguous)
  const recoveredRegistry = new WorktreeRegistry(path)
  const recovered = recoveredRegistry.getByCreationOperation('provision-1')!
  assert.equal(recovered.lifecycle, 'recovery-required')
  assert.equal(recovered.recoveryReason, 'create-ambiguous')

  const restarted = new WorktreeManager(operations, recoveredRegistry, join(root, 'worktrees'), () => undefined)
  await assert.rejects(restarted.provision(input(), new AbortController().signal),
    (error: WorktreeManagerError) => error.code === 'CONFLICT' && error.ambiguous)
  assert.equal(createCalls, 1)
})

test('fails before Git when the workspace is not authorized', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-auth-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let gitCalls = 0
  const manager = new WorktreeManager({
    discoverRepository: async () => {
      gitCalls += 1
      throw new Error('must not run')
    },
    resolveCommit: async () => 'a'.repeat(40),
    listWorktrees: async () => [],
    createWorktree: async () => ({ root: '/worktree', gitDir: '/worktree/.git', commonDir: '/repo/.git' }),
  }, new WorktreeRegistry(join(root, 'registry.json')), join(root, 'worktrees'), () => {
    throw new WorktreeManagerError('BAD_MESSAGE', 'Workspace is not active.')
  })

  await assert.rejects(manager.provision(input(), new AbortController().signal),
    (error: WorktreeManagerError) => error.code === 'BAD_MESSAGE')
  assert.equal(gitCalls, 0)
})

test('reconciles a registered branch moved to another checkout without mutating Git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-moved-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const reserved = registry.reserve({
    operationId: 'create-moved',
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    requestedBySessionId: 'session-source',
    executionMode: 'worktree',
    worktreePath: '/managed/original',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
  })
  registry.markReady(reserved.id, 'create-moved')
  const manager = new WorktreeManager({
    discoverRepository: async path => {
      if (path === '/managed/original') {
        throw new GitServiceError('INVALID_INPUT', 'The checkout is missing.')
      }
      return { root: path, gitDir: `${path}/.git`, commonDir: '/repo/.git' }
    },
    resolveCommit: async () => 'a'.repeat(40),
    listWorktrees: async () => [{
      path: '/managed/moved',
      head: 'a'.repeat(40),
      branch: 'refs/heads/dsh/session-123456789012345678901234',
      detached: false,
      bare: false,
      locked: true,
      lockReason: 'DSH Desktop session 123456789012',
      prunable: false,
    }],
    createWorktree: async () => { throw new Error('must not mutate Git') },
  }, registry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.snapshot.worktrees[0]?.recoveryReason, 'moved')
})

test('records an inspection failure without claiming that a checkout is missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-inspection-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const reserved = registry.reserve({
    operationId: 'create-inspection',
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    requestedBySessionId: 'session-source',
    executionMode: 'worktree',
    worktreePath: '/managed/inspection',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
  })
  registry.markReady(reserved.id, 'create-inspection')
  const manager = new WorktreeManager({
    discoverRepository: async path => ({ root: path, gitDir: `${path}/.git`, commonDir: '/repo/.git' }),
    resolveCommit: async () => 'a'.repeat(40),
    listWorktrees: async () => { throw new GitServiceError('TIMEOUT', 'Inspection timed out.') },
    createWorktree: async () => { throw new Error('must not mutate Git') },
  }, registry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.snapshot.worktrees[0]?.recoveryReason, 'inspection-failed')
})
