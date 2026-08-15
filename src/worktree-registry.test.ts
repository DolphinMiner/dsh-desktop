import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { GitRepositoryIdentity } from '@dolphinminer/dsh-desktop-protocol'

import {
  WorktreeRegistry,
  WorktreeRegistryError,
  WorktreeReservation,
} from './worktree-registry'

const repository: GitRepositoryIdentity = {
  root: '/repo',
  gitDir: '/repo/.git',
  commonDir: '/repo/.git',
}

function reservation(overrides: Partial<WorktreeReservation> = {}): WorktreeReservation {
  return {
    operationId: 'create-1',
    repository,
    requestedBySessionId: 'session-1',
    executionMode: 'worktree',
    worktreePath: '/worktrees/session-1',
    baseRef: 'refs/heads/main',
    baseCommit: 'a'.repeat(40),
    branch: 'refs/heads/dsh/session-1',
    ...overrides,
  }
}

test('persists immutable worktree identity and ready lifecycle across restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-registry-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worktrees.v1.json')
  let tick = 0
  const registry = new WorktreeRegistry(path, {
    now: () => new Date(Date.UTC(2026, 7, 16, 1, 0, tick++)),
  })

  const reserved = registry.reserve(reservation())
  assert.equal(reserved.lifecycle, 'provisioning')
  assert.deepEqual(reserved.pendingOperation, { id: 'create-1', kind: 'create' })
  assert.equal(registry.status().revision, 1)
  reserved.repository.root = '/mutated'
  assert.equal(registry.get(reserved.id)?.repository.root, '/repo')

  const ready = registry.markReady(reserved.id, 'create-1')
  assert.equal(ready.lifecycle, 'ready')
  assert.equal(ready.pendingOperation, undefined)
  assert.equal(registry.status().revision, 2)
  assert.equal(registry.markReady(reserved.id, 'create-1').lifecycle, 'ready')
  assert.equal(registry.status().revision, 2)

  const restored = new WorktreeRegistry(path)
  assert.equal(restored.status().available, true)
  assert.deepEqual(restored.list(), [ready])
  const document = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number; revision: number }
  assert.equal(document.schemaVersion, 1)
  assert.equal(document.revision, 2)
})

test('deduplicates creation and rejects shared mutable checkout assignments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-conflict-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'worktrees.v1.json'))

  const first = registry.reserve(reservation())
  assert.equal(registry.reserve(reservation()).id, first.id)
  assert.equal(registry.status().revision, 1)
  assert.throws(() => registry.reserve(reservation({ baseCommit: 'b'.repeat(40) })),
    (error: WorktreeRegistryError) => error.code === 'DUPLICATE_REQUEST')
  registry.markReady(first.id, 'create-1')
  assert.throws(() => registry.beginRemoval(first.id, 'create-1'),
    (error: WorktreeRegistryError) => error.code === 'DUPLICATE_REQUEST')
  assert.throws(() => registry.reserve(reservation({
    operationId: 'create-2',
    worktreePath: '/worktrees/other',
  })), (error: WorktreeRegistryError) => error.code === 'CONFLICT')
  assert.throws(() => registry.reserve(reservation({
    operationId: 'create-3',
    requestedBySessionId: 'session-2',
  })), (error: WorktreeRegistryError) => error.code === 'CONFLICT')

  const local = registry.reserve(reservation({
    operationId: 'create-local-1',
    requestedBySessionId: 'session-local-1',
    executionMode: 'local',
    worktreePath: undefined,
    branch: undefined,
  }))
  assert.equal(local.executionMode, 'local')
  assert.throws(() => registry.reserve(reservation({
    operationId: 'create-local-2',
    requestedBySessionId: 'session-local-2',
    executionMode: 'local',
    worktreePath: undefined,
    branch: undefined,
  })), (error: WorktreeRegistryError) => error.code === 'CONFLICT')
})

test('binds an official Harness session once without confusing it with the requester', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-binding-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'worktrees.v1.json'))
  const first = registry.reserve(reservation())
  registry.markReady(first.id, 'create-1')

  const bound = registry.bindSession(first.id, 'session-created')
  assert.equal(bound.requestedBySessionId, 'session-1')
  assert.equal(bound.sessionId, 'session-created')
  assert.equal(registry.bindSession(first.id, 'session-created').sessionId, 'session-created')
  assert.throws(() => registry.bindSession(first.id, 'session-other'),
    (error: WorktreeRegistryError) => error.code === 'CONFLICT')
})

test('persists a recovery inspection batch atomically in one revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-recovery-batch-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new WorktreeRegistry(join(root, 'worktrees.v1.json'))
  const first = registry.reserve(reservation())
  registry.markReady(first.id, 'create-1')
  const second = registry.reserve(reservation({
    operationId: 'create-2',
    requestedBySessionId: 'session-2',
    worktreePath: '/worktrees/session-2',
    branch: 'refs/heads/dsh/session-2',
  }))
  registry.markReady(second.id, 'create-2')
  const revision = registry.status().revision

  const reconciled = registry.requireRecoveryBatch([
    { id: first.id, reason: 'missing' },
    { id: second.id, reason: 'locked' },
  ])
  assert.deepEqual(reconciled.map(record => record.recoveryReason), ['missing', 'locked'])
  assert.equal(registry.status().revision, revision + 1)
  assert.throws(() => registry.requireRecoveryBatch([
    { id: first.id, reason: 'moved' },
    { id: 'missing-record', reason: 'missing' },
  ]), (error: WorktreeRegistryError) => error.code === 'NOT_FOUND')
  assert.equal(registry.get(first.id)?.recoveryReason, 'missing')
})

test('recovers interrupted create and remove operations without replaying them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-recovery-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worktrees.v1.json')

  const firstProcess = new WorktreeRegistry(path)
  const reserved = firstProcess.reserve(reservation())
  const afterCreateCrash = new WorktreeRegistry(path)
  const createRecovery = afterCreateCrash.get(reserved.id)!
  assert.equal(createRecovery.lifecycle, 'recovery-required')
  assert.equal(createRecovery.recoveryReason, 'interrupted-create')
  assert.deepEqual(createRecovery.pendingOperation, { id: 'create-1', kind: 'create' })
  const revisionBeforeInspection = afterCreateCrash.status().revision
  assert.equal(afterCreateCrash.requireRecoveryBatch([{
    id: reserved.id,
    reason: 'inspection-failed',
  }])[0]?.recoveryReason, 'interrupted-create')
  assert.equal(afterCreateCrash.status().revision, revisionBeforeInspection)

  afterCreateCrash.resolveRecovery(reserved.id, 'ready')
  const removing = afterCreateCrash.beginRemoval(reserved.id, 'remove-1')
  assert.equal(removing.lifecycle, 'removing')
  assert.equal(afterCreateCrash.beginRemoval(reserved.id, 'remove-1').lifecycle, 'removing')
  const revisionBeforeRestart = afterCreateCrash.status().revision

  const afterRemoveCrash = new WorktreeRegistry(path)
  const removeRecovery = afterRemoveCrash.get(reserved.id)!
  assert.equal(afterRemoveCrash.status().revision, revisionBeforeRestart + 1)
  assert.equal(removeRecovery.lifecycle, 'recovery-required')
  assert.equal(removeRecovery.recoveryReason, 'interrupted-remove')
  assert.deepEqual(removeRecovery.pendingOperation, { id: 'remove-1', kind: 'remove' })

  const removed = afterRemoveCrash.markRemoved(reserved.id, 'remove-1')
  assert.equal(removed.lifecycle, 'removed')
  assert.equal(removed.removalOperationId, 'remove-1')
  const removedRevision = afterRemoveCrash.status().revision
  assert.equal(afterRemoveCrash.markRemoved(reserved.id, 'remove-1').lifecycle, 'removed')
  assert.equal(afterRemoveCrash.status().revision, removedRevision)
  assert.equal(new WorktreeRegistry(path).get(reserved.id)?.lifecycle, 'removed')
})

test('fails closed for corrupt state and persistence failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-failure-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const corruptPath = join(root, 'corrupt.json')
  await writeFile(corruptPath, '{not json')
  const corrupt = new WorktreeRegistry(corruptPath)
  assert.equal(corrupt.status().available, false)
  assert.throws(() => corrupt.list(),
    (error: WorktreeRegistryError) => error.code === 'DESKTOP_UNAVAILABLE')

  const blocker = join(root, 'not-a-directory')
  await writeFile(blocker, 'blocked')
  const unavailable = new WorktreeRegistry(join(blocker, 'worktrees.json'))
  assert.throws(() => unavailable.reserve(reservation()),
    (error: WorktreeRegistryError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(unavailable.status().available, false)

  const unsupportedPath = join(root, 'unsupported.json')
  await writeFile(unsupportedPath, JSON.stringify({ schemaVersion: 2, revision: 0, records: [] }))
  const unsupported = new WorktreeRegistry(unsupportedPath)
  assert.equal(unsupported.status().available, false)
})

test('rejects invalid local and isolated reservation shapes before persistence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-validation-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'data'))
  const registry = new WorktreeRegistry(join(root, 'data', 'worktrees.json'))

  assert.throws(() => registry.reserve(reservation({ worktreePath: 'relative/path' })),
    (error: WorktreeRegistryError) => error.code === 'BAD_MESSAGE')
  assert.throws(() => registry.reserve(reservation({
    executionMode: 'local',
    worktreePath: '/worktrees/not-local',
  })), (error: WorktreeRegistryError) => error.code === 'BAD_MESSAGE')
  assert.throws(() => registry.reserve(reservation({ baseCommit: 'not-a-commit' })),
    (error: WorktreeRegistryError) => error.code === 'BAD_MESSAGE')
  assert.equal(registry.status().revision, 0)
})
