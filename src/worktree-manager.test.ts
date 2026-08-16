import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import type {
  CleanWorktreeCleanupInspection,
  GitRepositoryIdentity,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitCreateWorktreeInput, GitService, GitServiceError } from './git-service'
import {
  ProvisionWorktreeInput,
  WorktreeGitOperations,
  WorktreeManager,
  WorktreeManagerError,
} from './worktree-manager'
import { WorktreeRegistry } from './worktree-registry'
import type { WorktreeRecord } from './worktree-registry'

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

function readyWorktree(
  registry: WorktreeRegistry,
  suffix: string,
  worktreePath = `/managed/${suffix}`,
): WorktreeRecord {
  const record = registry.reserve({
    operationId: `create-${suffix}`,
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    requestedBySessionId: `session-${suffix}`,
    executionMode: 'worktree',
    worktreePath,
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
  })
  return registry.markReady(record.id, `create-${suffix}`)
}

function cleanupInspection(
  record: WorktreeRecord,
  head = record.baseCommit,
): CleanWorktreeCleanupInspection {
  return {
    worktreePath: record.worktreePath!,
    head,
    branch: record.branch!,
    clean: true,
    locked: true,
    changes: [],
  }
}

function cleanupOperations(
  record: WorktreeRecord,
  overrides: Partial<WorktreeGitOperations> = {},
): WorktreeGitOperations {
  return {
    discoverRepository: async path => path === record.repository.root
      ? record.repository
      : { root: path, gitDir: `${path}/.git`, commonDir: record.repository.commonDir },
    resolveCommit: async () => record.baseCommit,
    listWorktrees: async () => [{
      path: record.worktreePath!,
      head: record.baseCommit,
      branch: record.branch,
      detached: false,
      bare: false,
      locked: true,
      lockReason: 'DSH Desktop session 123456789012',
      prunable: false,
    }],
    createWorktree: async () => { throw new Error('must not create a worktree') },
    inspectWorktreeForRemoval: async () => cleanupInspection(record),
    inspectWorktreeHandoff: async () => { throw new Error('must not inspect a handoff') },
    transferWorktreeHandoff: async () => { throw new Error('must not transfer a handoff') },
    inspectWorktreeHandoffOutcome: async () => { throw new Error('must not inspect a handoff outcome') },
    removeWorktree: async () => undefined,
    moveWorktree: async () => { throw new Error('must not move a worktree') },
    inspectWorktreeMoveOutcome: async () => { throw new Error('must not inspect a worktree move outcome') },
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
  assert.equal(healthy.recovered, 0)
  assert.equal(healthy.recoveryRequired, 0)
  assert.equal(healthy.orphaned, 0)
  assert.equal(healthy.snapshot.worktrees[0]?.lifecycle, 'ready')

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

test('provisions an automation worktree from exact durable repository authority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-automation-worktree-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repositoryRoot = await repositoryFixture(root)
  const gitService = new GitService()
  const repository = await gitService.discoverRepository(repositoryRoot)
  const registry = new WorktreeRegistry(join(root, 'data', 'worktrees.v1.json'))
  let interactiveAuthorizations = 0
  const manager = new WorktreeManager(
    gitService,
    registry,
    join(root, 'managed-worktrees'),
    () => {
      interactiveAuthorizations += 1
      throw new Error('automation provisioning must not borrow a foreground session')
    },
  )
  const params = {
    operationId: 'automation-worktree:11111111-1111-4111-8111-111111111111',
    requestedBySessionId: '22222222-2222-4222-8222-222222222222',
    workspaceRoot: repositoryRoot,
    baseRef: 'refs/heads/main',
    repository,
  }

  const first = await manager.provisionAutomation(params, new AbortController().signal)
  assert.equal(first.created, true)
  assert.equal(first.record.lifecycle, 'ready')
  assert.equal(first.record.repository.root, repository.root)
  assert.equal(interactiveAuthorizations, 0)
  assert.equal(await git(first.record.worktreePath!, 'rev-parse', 'HEAD'), first.record.baseCommit)

  const duplicate = await manager.provisionAutomation(params, new AbortController().signal)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.record.id, first.record.id)
  assert.equal(interactiveAuthorizations, 0)

  await assert.rejects(manager.provisionAutomation({
    ...params,
    operationId: 'automation-worktree:33333333-3333-4333-8333-333333333333',
    requestedBySessionId: '44444444-4444-4444-8444-444444444444',
    repository: { ...repository, gitDir: join(repositoryRoot, '.replacement-git') },
  }, new AbortController().signal),
  (error: WorktreeManagerError) => error.code === 'TARGET_CHANGED' && error.ambiguous)
  assert.equal(registry.list().length, 1)
})

test('discovers a previously ready checkout with no bound Harness session as orphaned', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-orphan-reconcile-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worktrees.v1.json')
  const registry = new WorktreeRegistry(path)
  const record = readyWorktree(registry, 'orphan')
  const manager = new WorktreeManager(
    cleanupOperations(record),
    registry,
    '/managed',
    () => undefined,
  )
  const revision = registry.status().revision

  const liveRecheck = await manager.reconcile(new AbortController().signal)
  assert.equal(liveRecheck.recovered, 0)
  assert.equal(liveRecheck.orphaned, 0)
  assert.equal(liveRecheck.snapshot.worktrees[0]?.lifecycle, 'ready')
  assert.equal(registry.status().revision, revision)

  const result = await manager.reconcile(
    new AbortController().signal,
    { orphanUnboundReady: true },
  )
  assert.equal(result.healthy, 1)
  assert.equal(result.recovered, 0)
  assert.equal(result.recoveryRequired, 0)
  assert.equal(result.orphaned, 1)
  assert.equal(result.snapshot.worktrees[0]?.lifecycle, 'orphaned')
  assert.equal(registry.status().revision, revision + 1)

  const duplicate = await manager.reconcile(
    new AbortController().signal,
    { orphanUnboundReady: true },
  )
  assert.equal(duplicate.orphaned, 1)
  assert.equal(registry.status().revision, revision + 1)
  assert.equal(new WorktreeRegistry(path).get(record.id)?.lifecycle, 'orphaned')
})

test('recovers a repaired checkout only after an authoritative healthy inspection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-health-recovery-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worktrees.v1.json')
  const registry = new WorktreeRegistry(path)
  const record = readyWorktree(registry, 'health-recovery')
  registry.requireRecovery(record.id, 'locked')
  const manager = new WorktreeManager(
    cleanupOperations(record),
    registry,
    '/managed',
    () => undefined,
  )

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.healthy, 1)
  assert.equal(result.recovered, 1)
  assert.equal(result.recoveryRequired, 0)
  assert.equal(result.snapshot.worktrees[0]?.lifecycle, 'ready')
  assert.equal(new WorktreeRegistry(path).get(record.id)?.recoveryReason, undefined)
})

test('recovers an interrupted create as orphaned after startup proves the checkout exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-create-recovery-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worktrees.v1.json')
  const firstProcess = new WorktreeRegistry(path)
  const reserved = firstProcess.reserve({
    operationId: 'create-recovery',
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    requestedBySessionId: 'session-create-recovery',
    executionMode: 'worktree',
    worktreePath: '/managed/create-recovery',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-123456789012345678901234',
  })
  const recoveredRegistry = new WorktreeRegistry(path)
  const interrupted = recoveredRegistry.get(reserved.id)!
  assert.equal(interrupted.recoveryReason, 'interrupted-create')
  const manager = new WorktreeManager(
    cleanupOperations(interrupted),
    recoveredRegistry,
    '/managed',
    () => undefined,
  )

  const result = await manager.reconcile(
    new AbortController().signal,
    { orphanUnboundReady: true },
  )
  assert.equal(result.recovered, 1)
  assert.equal(result.orphaned, 1)
  assert.equal(result.recoveryRequired, 0)
  assert.equal(result.snapshot.worktrees[0]?.lifecycle, 'orphaned')
  assert.equal(recoveredRegistry.get(reserved.id)?.pendingOperation, undefined)
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
    inspectWorktreeForRemoval: async request => ({
      worktreePath: request.worktreePath,
      head: 'a'.repeat(40),
      branch: request.branch,
      clean: true,
      locked: true,
      changes: [],
    }),
    inspectWorktreeHandoff: async () => { throw new Error('must not inspect a handoff') },
    transferWorktreeHandoff: async () => { throw new Error('must not transfer a handoff') },
    inspectWorktreeHandoffOutcome: async () => { throw new Error('must not inspect a handoff outcome') },
    removeWorktree: async () => undefined,
    moveWorktree: async () => { throw new Error('must not move a worktree') },
    inspectWorktreeMoveOutcome: async () => { throw new Error('must not inspect a worktree move outcome') },
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
    inspectWorktreeForRemoval: async request => ({
      worktreePath: request.worktreePath,
      head: 'a'.repeat(40),
      branch: request.branch,
      clean: true,
      locked: true,
      changes: [],
    }),
    inspectWorktreeHandoff: async () => { throw new Error('must not inspect a handoff') },
    transferWorktreeHandoff: async () => { throw new Error('must not transfer a handoff') },
    inspectWorktreeHandoffOutcome: async () => { throw new Error('must not inspect a handoff outcome') },
    removeWorktree: async () => undefined,
    moveWorktree: async () => { throw new Error('must not move a worktree') },
    inspectWorktreeMoveOutcome: async () => { throw new Error('must not inspect a worktree move outcome') },
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
    inspectWorktreeForRemoval: async () => { throw new Error('must not run') },
    inspectWorktreeHandoff: async () => { throw new Error('must not run') },
    transferWorktreeHandoff: async () => { throw new Error('must not run') },
    inspectWorktreeHandoffOutcome: async () => { throw new Error('must not run') },
    removeWorktree: async () => { throw new Error('must not run') },
    moveWorktree: async () => { throw new Error('must not run') },
    inspectWorktreeMoveOutcome: async () => { throw new Error('must not run') },
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
    inspectWorktreeForRemoval: async () => { throw new Error('must not mutate Git') },
    inspectWorktreeHandoff: async () => { throw new Error('must not mutate Git') },
    transferWorktreeHandoff: async () => { throw new Error('must not mutate Git') },
    inspectWorktreeHandoffOutcome: async () => { throw new Error('must not inspect a handoff outcome') },
    removeWorktree: async () => { throw new Error('must not mutate Git') },
    moveWorktree: async () => { throw new Error('must not mutate Git') },
    inspectWorktreeMoveOutcome: async () => { throw new Error('must not inspect a worktree move outcome') },
  }, registry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.snapshot.worktrees[0]?.recoveryReason, 'moved')
})

test('restores a real moved managed checkout only from freshly inspected Git evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-restore-moved-real-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repositoryRoot = await repositoryFixture(root)
  const registry = new WorktreeRegistry(join(root, 'data', 'worktrees.v1.json'))
  const gitService = new GitService()
  const manager = new WorktreeManager(
    gitService,
    registry,
    join(root, 'managed-worktrees'),
    () => undefined,
  )
  const created = (await manager.provision(input({
    operationId: 'provision-restore-moved-real',
    requestedBySessionId: 'session-restore-moved-real',
    workspaceRoot: repositoryRoot,
  }), new AbortController().signal)).record
  const registeredPath = created.worktreePath!
  const movedPath = join(await realpath(root), 'externally-moved-worktree')
  const entry = (await gitService.listWorktrees(repositoryRoot))
    .find(candidate => candidate.path === registeredPath)!
  assert.ok(entry.lockReason)
  await writeFile(join(registeredPath, 'README.md'), 'preserved tracked change\n')
  await writeFile(join(registeredPath, 'notes.txt'), 'preserved untracked change\n')
  await git(repositoryRoot, 'worktree', 'unlock', registeredPath)
  await git(repositoryRoot, 'worktree', 'move', registeredPath, movedPath)
  await git(repositoryRoot, 'worktree', 'lock', '--reason', entry.lockReason, movedPath)

  const reconciled = await manager.reconcile(new AbortController().signal)
  assert.equal(reconciled.snapshot.worktrees[0]?.recoveryReason, 'moved')
  const stale = await manager.inspectMovedWorktree(created.id, new AbortController().signal)
  assert.equal(stale.inspection.registeredPath, registeredPath)
  assert.equal(stale.inspection.current.worktreePath, movedPath)
  assert.deepEqual(stale.inspection.current.changes.map(change => change.path), ['README.md', 'notes.txt'])

  await writeFile(join(movedPath, 'later.txt'), 'changed after preview\n')
  let dispatches = 0
  await assert.rejects(manager.restoreMovedWorktree(
    created.id,
    stale.inspection,
    new AbortController().signal,
    () => { dispatches += 1 },
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && !error.ambiguous)
  assert.equal(dispatches, 0)
  await access(movedPath)
  await assert.rejects(access(registeredPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')

  const reviewed = await manager.inspectMovedWorktree(created.id, new AbortController().signal)
  const restored = await manager.restoreMovedWorktree(
    created.id,
    reviewed.inspection,
    new AbortController().signal,
    record => {
      assert.equal(record.lifecycle, 'recovery-required')
      assert.equal(record.recoveryReason, 'moved')
      dispatches += 1
    },
  )
  assert.equal(dispatches, 1)
  assert.equal(restored.lifecycle, 'orphaned')
  assert.equal(restored.recoveryReason, undefined)
  await access(registeredPath)
  await assert.rejects(access(movedPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  assert.equal(await readFile(join(registeredPath, 'README.md'), 'utf8'), 'preserved tracked change\n')
  assert.equal(await readFile(join(registeredPath, 'notes.txt'), 'utf8'), 'preserved untracked change\n')
  assert.equal(await readFile(join(registeredPath, 'later.txt'), 'utf8'), 'changed after preview\n')
  assert.equal(await manager.inspectMovedWorktreeOutcome(
    created.id,
    reviewed.inspection,
    new AbortController().signal,
  ), 'completed')
  const restoredEntry = (await gitService.listWorktrees(repositoryRoot))
    .find(candidate => candidate.branch === created.branch)
  assert.equal(restoredEntry?.path, registeredPath)
  assert.equal(restoredEntry?.locked, true)
  assert.equal(restoredEntry?.lockReason, entry.lockReason)
  assert.equal(await git(repositoryRoot, 'rev-parse', created.branch!), created.baseCommit)
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
    inspectWorktreeForRemoval: async () => { throw new Error('must not mutate Git') },
    inspectWorktreeHandoff: async () => { throw new Error('must not mutate Git') },
    transferWorktreeHandoff: async () => { throw new Error('must not mutate Git') },
    inspectWorktreeHandoffOutcome: async () => { throw new Error('must not inspect a handoff outcome') },
    removeWorktree: async () => { throw new Error('must not mutate Git') },
    moveWorktree: async () => { throw new Error('must not mutate Git') },
    inspectWorktreeMoveOutcome: async () => { throw new Error('must not inspect a worktree move outcome') },
  }, registry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.snapshot.worktrees[0]?.recoveryReason, 'inspection-failed')
})

test('persists cleanup intent before removal and does not redispatch a completed operation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const record = readyWorktree(registry, 'cleanup')
  let removeCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    removeWorktree: async request => {
      removeCalls += 1
      assert.equal(request.worktreePath, record.worktreePath)
      assert.equal(request.head, record.baseCommit)
      const persisted = registry.get(record.id)
      assert.equal(persisted?.lifecycle, 'removing')
      assert.deepEqual(persisted?.pendingOperation, { id: 'cleanup-operation', kind: 'remove' })
    },
  }), registry, '/managed', () => undefined)

  const preview = await manager.inspectCleanup(record.id, new AbortController().signal)
  const removed = await manager.removeCleanWorktree(
    record.id,
    'cleanup-operation',
    preview.inspection,
    new AbortController().signal,
  )
  assert.equal(removed.lifecycle, 'removed')
  assert.equal(removed.removalOperationId, 'cleanup-operation')
  assert.equal(removeCalls, 1)
  assert.equal(manager.snapshot().worktrees.length, 0)

  const duplicate = await manager.removeCleanWorktree(
    record.id,
    'cleanup-operation',
    preview.inspection,
    new AbortController().signal,
  )
  assert.equal(duplicate.lifecycle, 'removed')
  assert.equal(removeCalls, 1)
})

test('rejects cleanup when the approved worktree inspection changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-drift-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const record = readyWorktree(registry, 'cleanup-drift')
  let head = record.baseCommit
  let removeCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    inspectWorktreeForRemoval: async () => cleanupInspection(record, head),
    removeWorktree: async () => { removeCalls += 1 },
  }), registry, '/managed', () => undefined)

  const preview = await manager.inspectCleanup(record.id, new AbortController().signal)
  head = 'b'.repeat(40)
  await assert.rejects(manager.removeCleanWorktree(
    record.id,
    'cleanup-drift-operation',
    preview.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && !error.ambiguous)
  assert.equal(registry.get(record.id)?.lifecycle, 'ready')
  assert.equal(removeCalls, 0)
})

test('keeps an ambiguous cleanup durable and never replays it after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-timeout-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registryPath = join(root, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const record = readyWorktree(registry, 'cleanup-timeout')
  let removeCalls = 0
  const operations = cleanupOperations(record, {
    removeWorktree: async () => {
      removeCalls += 1
      throw new GitServiceError('TIMEOUT', 'Git worktree cleanup timed out.')
    },
  })
  const manager = new WorktreeManager(operations, registry, '/managed', () => undefined)
  const preview = await manager.inspectCleanup(record.id, new AbortController().signal)

  await assert.rejects(manager.removeCleanWorktree(
    record.id,
    'cleanup-timeout-operation',
    preview.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'TIMEOUT' && error.ambiguous)
  const interrupted = registry.get(record.id)
  assert.equal(interrupted?.lifecycle, 'recovery-required')
  assert.equal(interrupted?.recoveryReason, 'interrupted-remove')
  assert.deepEqual(interrupted?.pendingOperation, { id: 'cleanup-timeout-operation', kind: 'remove' })

  const restarted = new WorktreeManager(
    operations,
    new WorktreeRegistry(registryPath),
    '/managed',
    () => undefined,
  )
  await assert.rejects(restarted.removeCleanWorktree(
    record.id,
    'cleanup-timeout-operation',
    preview.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'DUPLICATE_REQUEST' && error.ambiguous)
  assert.equal(removeCalls, 1)
})

test('reconciles an interrupted cleanup only after Git and the checkout path are absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-reconcile-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registryPath = join(root, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const record = readyWorktree(registry, 'cleanup-reconcile')
  registry.beginRemoval(record.id, 'cleanup-reconcile-operation')
  const recoveredRegistry = new WorktreeRegistry(registryPath)
  let removeCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    discoverRepository: async path => {
      if (path === record.worktreePath) {
        throw new GitServiceError('INVALID_INPUT', 'The checkout is missing.')
      }
      return record.repository
    },
    listWorktrees: async () => [{
      path: record.repository.root,
      head: record.baseCommit,
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    }],
    removeWorktree: async () => { removeCalls += 1 },
  }), recoveredRegistry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.snapshot.worktrees.length, 0)
  assert.equal(recoveredRegistry.get(record.id)?.lifecycle, 'removed')
  assert.equal(recoveredRegistry.get(record.id)?.removalOperationId, 'cleanup-reconcile-operation')
  assert.equal(removeCalls, 0)
})

test('preserves interrupted cleanup state while the checkout still exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-present-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registryPath = join(root, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const record = readyWorktree(registry, 'cleanup-present')
  registry.beginRemoval(record.id, 'cleanup-present-operation')
  const recoveredRegistry = new WorktreeRegistry(registryPath)
  let removeCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    removeWorktree: async () => { removeCalls += 1 },
  }), recoveredRegistry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.recovered, 0)
  assert.equal(result.snapshot.worktrees[0]?.lifecycle, 'recovery-required')
  assert.equal(result.snapshot.worktrees[0]?.recoveryReason, 'interrupted-remove')
  assert.equal(removeCalls, 0)
})

test('keeps an exact interrupted cleanup without mutating Git or checkout files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-keep-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registryPath = join(root, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const record = readyWorktree(registry, 'cleanup-keep')
  registry.beginRemoval(record.id, 'cleanup-keep-operation')
  const recoveredRegistry = new WorktreeRegistry(registryPath)
  let inspection = cleanupInspection(record)
  let removeCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    inspectWorktreeForRemoval: async () => inspection,
    removeWorktree: async () => { removeCalls += 1 },
  }), recoveredRegistry, '/managed', () => undefined)

  const preview = await manager.inspectInterruptedRemoval(record.id, new AbortController().signal)
  assert.equal(preview.removalOperationId, 'cleanup-keep-operation')
  const kept = await manager.keepInterruptedRemoval(
    record.id,
    preview.removalOperationId,
    preview.inspection,
    new AbortController().signal,
  )
  assert.equal(kept.lifecycle, 'orphaned')
  assert.equal(kept.pendingOperation, undefined)
  assert.equal(removeCalls, 0)

  const secondRegistry = new WorktreeRegistry(join(root, 'second-registry.json'))
  const second = readyWorktree(secondRegistry, 'cleanup-keep-drift')
  secondRegistry.beginRemoval(second.id, 'cleanup-keep-drift-operation')
  const interrupted = new WorktreeRegistry(join(root, 'second-registry.json'))
  inspection = cleanupInspection(second)
  const driftManager = new WorktreeManager(cleanupOperations(second, {
    inspectWorktreeForRemoval: async () => inspection,
  }), interrupted, '/managed', () => undefined)
  const stale = await driftManager.inspectInterruptedRemoval(second.id, new AbortController().signal)
  inspection = cleanupInspection(second, 'b'.repeat(40))
  await assert.rejects(driftManager.keepInterruptedRemoval(
    second.id,
    stale.removalOperationId,
    stale.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && !error.ambiguous)
  assert.equal(interrupted.get(second.id)?.recoveryReason, 'interrupted-remove')
})

test('forgets a missing checkout only while Git metadata and its path remain absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-forget-missing-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const record = readyWorktree(registry, 'forget-missing', join(root, 'missing-checkout'))
  registry.requireRecovery(record.id, 'missing')
  let mutationCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    listWorktrees: async () => [],
    createWorktree: async () => {
      mutationCalls += 1
      throw new Error('must not create a worktree')
    },
    removeWorktree: async () => { mutationCalls += 1 },
  }), registry, join(root, 'managed'), () => undefined)

  const preview = await manager.inspectMissingWorktree(record.id, new AbortController().signal)
  assert.deepEqual(preview.inspection, {
    repositoryRoot: record.repository.root,
    worktreePath: record.worktreePath,
    branch: record.branch,
    worktreeMetadataAbsent: true,
    checkoutPathAbsent: true,
  })
  const forgotten = await manager.forgetMissingWorktree(
    record.id,
    'forget-missing-operation',
    preview.inspection,
    new AbortController().signal,
  )
  assert.equal(forgotten.lifecycle, 'removed')
  assert.deepEqual(manager.snapshot().worktrees, [])
  assert.equal(manager.getByOperation('forget-missing-operation'), undefined)
  assert.equal(mutationCalls, 0)

  const driftRegistry = new WorktreeRegistry(join(root, 'drift-registry.json'))
  const drifted = readyWorktree(driftRegistry, 'forget-missing-drift', join(root, 'drift-checkout'))
  driftRegistry.requireRecovery(drifted.id, 'missing')
  let entries: Awaited<ReturnType<WorktreeGitOperations['listWorktrees']>> = []
  let observedRepository = drifted.repository
  const driftManager = new WorktreeManager(cleanupOperations(drifted, {
    discoverRepository: async () => observedRepository,
    listWorktrees: async () => entries,
  }), driftRegistry, join(root, 'managed'), () => undefined)
  const stale = await driftManager.inspectMissingWorktree(drifted.id, new AbortController().signal)
  entries = [{
    path: drifted.worktreePath!,
    head: drifted.baseCommit,
    branch: drifted.branch,
    detached: false,
    bare: false,
    locked: true,
    lockReason: 'DSH Desktop session 123456789012',
    prunable: false,
  }]
  await assert.rejects(driftManager.forgetMissingWorktree(
    drifted.id,
    'forget-missing-drift-operation',
    stale.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT')
  assert.equal(driftRegistry.get(drifted.id)?.recoveryReason, 'missing')

  entries = [{ ...entries[0]!, path: join(root, 'moved-checkout') }]
  await assert.rejects(driftManager.forgetMissingWorktree(
    drifted.id,
    'forget-missing-moved-operation',
    stale.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && /another path/i.test(error.message))

  entries = []
  observedRepository = { ...drifted.repository, commonDir: '/other/.git' }
  await assert.rejects(driftManager.forgetMissingWorktree(
    drifted.id,
    'forget-missing-identity-operation',
    stale.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && error.ambiguous)

  observedRepository = drifted.repository
  await mkdir(drifted.worktreePath!)
  await assert.rejects(driftManager.forgetMissingWorktree(
    drifted.id,
    'forget-missing-path-operation',
    stale.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && error.ambiguous)
  assert.equal(driftRegistry.get(drifted.id)?.recoveryReason, 'missing')
})

test('forgets an externally removed real Git worktree while preserving its branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-forget-missing-real-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repositoryRoot = await repositoryFixture(root)
  const registry = new WorktreeRegistry(join(root, 'data', 'worktrees.v1.json'))
  const manager = new WorktreeManager(
    new GitService(),
    registry,
    join(root, 'managed-worktrees'),
    () => undefined,
  )
  const created = (await manager.provision(input({
    operationId: 'provision-forget-missing-real',
    requestedBySessionId: 'session-forget-missing-real',
    workspaceRoot: repositoryRoot,
  }), new AbortController().signal)).record

  await git(repositoryRoot, 'worktree', 'unlock', created.worktreePath!)
  await git(repositoryRoot, 'worktree', 'remove', created.worktreePath!)
  await assert.rejects(access(created.worktreePath!))
  const reconciled = await manager.reconcile(new AbortController().signal)
  assert.equal(reconciled.snapshot.worktrees[0]?.recoveryReason, 'missing')

  const preview = await manager.inspectMissingWorktree(created.id, new AbortController().signal)
  const forgotten = await manager.forgetMissingWorktree(
    created.id,
    'forget-missing-real-operation',
    preview.inspection,
    new AbortController().signal,
  )
  assert.equal(forgotten.lifecycle, 'removed')
  assert.equal(await git(repositoryRoot, 'rev-parse', created.branch!), created.baseCommit)
  await assert.rejects(access(created.worktreePath!))
  assert.deepEqual(manager.snapshot().worktrees, [])
})

test('stops tracking only an exact external identity without invoking Git mutations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-stop-tracking-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'changed-checkout')
  await mkdir(checkout)
  await writeFile(join(checkout, 'owned-by-user.txt'), 'keep me\n')
  const registryPath = join(root, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const record = readyWorktree(registry, 'stop-tracking', checkout)
  registry.requireRecovery(record.id, 'external-change')
  let observedCheckout: GitRepositoryIdentity = {
    root: checkout,
    gitDir: join(checkout, '.git'),
    commonDir: join(checkout, '.git'),
  }
  let mutationCalls = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    discoverRepository: async path => path === record.repository.root ? record.repository : observedCheckout,
    listWorktrees: async () => [],
    createWorktree: async () => {
      mutationCalls += 1
      throw new Error('must not create a worktree')
    },
    removeWorktree: async () => { mutationCalls += 1 },
    moveWorktree: async () => { mutationCalls += 1 },
    transferWorktreeHandoff: async () => {
      mutationCalls += 1
      throw new Error('must not transfer a handoff')
    },
  }), registry, join(root, 'managed'), () => undefined)

  const stale = await manager.inspectExternalChangeWorktree(record.id, new AbortController().signal)
  assert.equal(stale.inspection.repositoryRootObservation.state, 'matching')
  assert.equal(stale.inspection.checkoutObservation.state, 'changed')
  assert.equal(stale.inspection.registrationObservation.state, 'missing')
  observedCheckout = { ...observedCheckout, gitDir: join(checkout, '.git-2'), commonDir: join(checkout, '.git-2') }
  await assert.rejects(manager.stopTrackingExternalChange(
    record.id,
    'stop-tracking-stale',
    stale.inspection,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && !error.ambiguous)
  assert.equal(registry.get(record.id)?.recoveryReason, 'external-change')

  const fresh = await manager.inspectExternalChangeWorktree(record.id, new AbortController().signal)
  const stopped = await manager.stopTrackingExternalChange(
    record.id,
    'stop-tracking-operation',
    fresh.inspection,
    new AbortController().signal,
  )
  assert.equal(stopped.lifecycle, 'removed')
  assert.deepEqual(manager.snapshot().worktrees, [])
  assert.equal(manager.getByStopTrackingOperation('stop-tracking-operation')?.id, record.id)
  assert.equal(await readFile(join(checkout, 'owned-by-user.txt'), 'utf8'), 'keep me\n')
  assert.equal(mutationCalls, 0)
  assert.equal(new WorktreeRegistry(registryPath).get(record.id)?.lifecycle, 'removed')
})

test('leaves a replacement repository and the original managed branch untouched when tracking stops', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-stop-tracking-real-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repositoryRoot = await repositoryFixture(root)
  const registryPath = join(root, 'data', 'worktrees.v1.json')
  const registry = new WorktreeRegistry(registryPath)
  const manager = new WorktreeManager(
    new GitService(),
    registry,
    join(root, 'managed-worktrees'),
    () => undefined,
  )
  const created = (await manager.provision(input({
    operationId: 'provision-stop-tracking-real',
    requestedBySessionId: 'session-stop-tracking-real',
    workspaceRoot: repositoryRoot,
  }), new AbortController().signal)).record

  await git(repositoryRoot, 'worktree', 'unlock', created.worktreePath!)
  await git(repositoryRoot, 'worktree', 'remove', created.worktreePath!)
  await mkdir(created.worktreePath!)
  await git(created.worktreePath!, 'init', '-b', 'replacement')
  await git(created.worktreePath!, 'config', 'user.name', 'Replacement Test')
  await git(created.worktreePath!, 'config', 'user.email', 'replacement@example.invalid')
  await writeFile(join(created.worktreePath!, 'replacement.txt'), 'replacement repository\n')
  await git(created.worktreePath!, 'add', 'replacement.txt')
  await git(created.worktreePath!, 'commit', '-m', 'replacement')

  const reconciled = await manager.reconcile(new AbortController().signal)
  assert.equal(reconciled.snapshot.worktrees[0]?.recoveryReason, 'external-change')
  const preview = await manager.inspectExternalChangeWorktree(created.id, new AbortController().signal)
  assert.equal(preview.inspection.repositoryRootObservation.state, 'matching')
  assert.equal(preview.inspection.checkoutObservation.state, 'changed')
  assert.equal(preview.inspection.registrationObservation.state, 'missing')
  const replacementHead = await git(created.worktreePath!, 'rev-parse', 'HEAD')

  const stopped = await manager.stopTrackingExternalChange(
    created.id,
    'stop-tracking-real-operation',
    preview.inspection,
    new AbortController().signal,
  )
  assert.equal(stopped.lifecycle, 'removed')
  assert.equal(await readFile(join(created.worktreePath!, 'replacement.txt'), 'utf8'), 'replacement repository\n')
  assert.equal(await git(created.worktreePath!, 'rev-parse', 'HEAD'), replacementHead)
  assert.equal(await git(repositoryRoot, 'rev-parse', created.branch!), created.baseCommit)
  assert.equal(new WorktreeRegistry(registryPath).getByStopTrackingOperation(
    'stop-tracking-real-operation',
  )?.id, created.id)
})

test('does not claim an interrupted cleanup completed when a non-repository path remains', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-cleanup-replaced-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'replacement-directory')
  await mkdir(checkout)
  const registryPath = join(root, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const record = readyWorktree(registry, 'cleanup-replaced', checkout)
  registry.beginRemoval(record.id, 'cleanup-replaced-operation')
  const recoveredRegistry = new WorktreeRegistry(registryPath)
  const manager = new WorktreeManager(cleanupOperations(record, {
    discoverRepository: async path => {
      if (path === checkout) throw new GitServiceError('INVALID_INPUT', 'The checkout is not a repository.')
      return record.repository
    },
    listWorktrees: async () => [{
      path: record.repository.root,
      head: record.baseCommit,
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    }],
    removeWorktree: async () => { throw new Error('must not replay cleanup') },
  }), recoveredRegistry, '/managed', () => undefined)

  const result = await manager.reconcile(new AbortController().signal)
  assert.equal(result.snapshot.worktrees[0]?.lifecycle, 'recovery-required')
  assert.equal(result.snapshot.worktrees[0]?.recoveryReason, 'interrupted-remove')
  await access(checkout)
})

test('binds handoff preflight to the immutable managed worktree identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const record = readyWorktree(registry, 'handoff-manager')
  let inspectedInput: object | undefined
  const manager = new WorktreeManager(cleanupOperations(record, {
    inspectWorktreeHandoff: async input => {
      inspectedInput = input
      return {
        direction: input.direction,
        baseCommit: input.baseCommit,
        sourceTree: 'b'.repeat(40),
        source: {
          kind: 'worktree',
          path: record.worktreePath!,
          branch: record.branch!.slice('refs/heads/'.length),
          head: record.baseCommit,
          clean: false,
        },
        destination: {
          kind: 'local',
          path: record.repository.root,
          branch: 'main',
          head: record.baseCommit,
          clean: true,
        },
        files: [{ status: 'modified', path: 'README.md', patchAvailable: true }],
        patch: 'diff --git a/README.md b/README.md\n',
        blockers: [],
        canTransfer: true,
      }
    },
  }), registry, '/managed', () => undefined)

  const state = await manager.inspectHandoff(
    record.id,
    'worktree-to-local',
    new AbortController().signal,
  )
  const preflight = state.preflight
  assert.equal(state.record.id, record.id)
  assert.equal(preflight.worktree.id, record.id)
  assert.equal(preflight.canTransfer, true)
  assert.deepEqual(inspectedInput, {
    repositoryRoot: '/repo',
    worktreePath: '/managed/handoff-manager',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    lockReason: 'DSH Desktop session 123456789012',
    baseCommit: 'a'.repeat(40),
    direction: 'worktree-to-local',
  })
})

test('binds handoff transfer and outcome inspection to the managed identity and dispatch boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-transfer-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const record = readyWorktree(registry, 'handoff-transfer-manager')
  const expected = {
    direction: 'worktree-to-local' as const,
    baseCommit: record.baseCommit,
    sourceTree: 'b'.repeat(40),
    sourceHead: 'c'.repeat(40),
    sourceBranch: record.branch!.slice('refs/heads/'.length),
    destinationBranch: 'main',
  }
  let transferredInput: object | undefined
  let outcomeInput: object | undefined
  let dispatches = 0
  const manager = new WorktreeManager(cleanupOperations(record, {
    transferWorktreeHandoff: async (input, _signal, beforeDispatch) => {
      transferredInput = input
      beforeDispatch?.()
      return {
        sourceTree: input.expectedSourceTree,
        destination: {
          repository: record.repository,
          head: record.baseCommit,
          branch: 'main',
          ahead: 0,
          behind: 0,
          clean: false,
          entries: [{
            kind: 'ordinary',
            path: 'README.md',
            indexStatus: 'M',
            worktreeStatus: '.',
          }],
        },
      }
    },
    inspectWorktreeHandoffOutcome: async input => {
      outcomeInput = input
      return 'completed'
    },
  }), registry, '/managed', () => undefined)

  const transferred = await manager.transferHandoff(
    record.id,
    expected,
    new AbortController().signal,
    current => {
      assert.equal(current.id, record.id)
      dispatches += 1
    },
  )
  assert.equal(transferred.result.sourceTree, expected.sourceTree)
  assert.equal(dispatches, 1)
  assert.equal(await manager.inspectHandoffOutcome(record.id, expected, new AbortController().signal), 'completed')
  const exactInput = {
    repositoryRoot: '/repo',
    worktreePath: '/managed/handoff-transfer-manager',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    lockReason: 'DSH Desktop session 123456789012',
    baseCommit: 'a'.repeat(40),
    direction: 'worktree-to-local',
    expectedSourceTree: 'b'.repeat(40),
    expectedSourceHead: 'c'.repeat(40),
    expectedSourceBranch: 'dsh/session-123456789012345678901234',
    expectedDestinationBranch: 'main',
  }
  assert.deepEqual(transferredInput, exactInput)
  assert.deepEqual(outcomeInput, exactInput)
})

test('marks only handoff failures after the dispatch callback as ambiguous', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-ambiguity-manager-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'registry.json'))
  const record = readyWorktree(registry, 'handoff-ambiguity-manager')
  const expected = {
    direction: 'local-to-worktree' as const,
    baseCommit: record.baseCommit,
    sourceTree: 'b'.repeat(40),
    sourceHead: record.baseCommit,
    sourceBranch: 'main',
    destinationBranch: record.branch!.slice('refs/heads/'.length),
  }
  const manager = new WorktreeManager(cleanupOperations(record, {
    transferWorktreeHandoff: async (_input, _signal, beforeDispatch) => {
      beforeDispatch?.()
      throw new GitServiceError('TIMEOUT', 'The handoff timed out.')
    },
  }), registry, '/managed', () => undefined)

  await assert.rejects(manager.transferHandoff(
    record.id,
    expected,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'TIMEOUT' && error.ambiguous)

  const beforeDispatch = new WorktreeManager(cleanupOperations(record, {
    transferWorktreeHandoff: async () => {
      throw new GitServiceError('GIT_FAILED', 'The source changed.')
    },
  }), registry, '/managed', () => undefined)
  await assert.rejects(beforeDispatch.transferHandoff(
    record.id,
    expected,
    new AbortController().signal,
  ), (error: WorktreeManagerError) => error.code === 'CONFLICT' && !error.ambiguous)
})
