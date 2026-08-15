import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  WorktreeHandoffJournal,
  WorktreeHandoffJournalError,
  worktreeHandoffOperationPhase,
  type BeginWorktreeHandoffOperationInput,
} from './worktree-handoff-journal'

const operationId = '11111111-1111-4111-8111-111111111111'

function input(overrides: Partial<BeginWorktreeHandoffOperationInput> = {}): BeginWorktreeHandoffOperationInput {
  return {
    operationId,
    worktreeId: '22222222-2222-4222-8222-222222222222',
    direction: 'local-to-worktree',
    repositoryRoot: '/repo',
    repositoryCommonDir: '/repo/.git',
    worktreePath: '/managed/worktree',
    branch: 'refs/heads/dsh/session-123456789012345678901234',
    baseCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    source: { kind: 'local', path: '/repo', branch: 'main', head: 'c'.repeat(40), clean: false },
    destination: {
      kind: 'worktree',
      path: '/managed/worktree',
      branch: 'dsh/session-123456789012345678901234',
      head: 'a'.repeat(40),
      clean: true,
    },
    files: [{ status: 'modified', path: 'src/index.ts', patchAvailable: true }],
    patchFingerprint: 'd'.repeat(64),
    approvalFingerprint: 'e'.repeat(64),
    ...overrides,
  }
}

function clock(): () => Date {
  let timestamp = Date.parse('2026-08-16T12:00:00.000Z')
  return () => {
    const value = new Date(timestamp)
    timestamp += 1_000
    return value
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-journal-test-'))
  return { root, path: join(root, 'worktree-handoffs.v1.json') }
}

test('persists the reviewed handoff payload before dispatch and deduplicates exact retries', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new WorktreeHandoffJournal(path, { now: clock() })

  assert.equal(journal.begin(input()).created, true)
  assert.equal(journal.begin(input()).created, false)
  journal.recordDispatch(operationId)
  journal.recordOutcome(operationId, 'succeeded', 'completed')

  const restored = new WorktreeHandoffJournal(path)
  const operation = restored.get(operationId)!
  assert.equal(worktreeHandoffOperationPhase(operation), 'succeeded')
  assert.deepEqual(operation.events.map(event => event.phase), ['intent', 'dispatch', 'succeeded'])
  assert.equal(operation.sourceTree, 'b'.repeat(40))
  assert.deepEqual(operation.files, [{ status: 'modified', path: 'src/index.ts', patchAvailable: true }])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 1)
})

test('recovers intent as cancelled and dispatched work as ambiguous without replay', async t => {
  const first = await fixture()
  t.after(() => rm(first.root, { recursive: true, force: true }))
  new WorktreeHandoffJournal(first.path, { now: clock() }).begin(input())
  const cancelled = new WorktreeHandoffJournal(first.path, { now: clock() }).get(operationId)!
  assert.equal(worktreeHandoffOperationPhase(cancelled), 'cancelled')
  assert.equal(cancelled.events.at(-1)?.reason, 'interrupted-before-dispatch')

  const second = await fixture()
  t.after(() => rm(second.root, { recursive: true, force: true }))
  const journal = new WorktreeHandoffJournal(second.path, { now: clock() })
  journal.begin(input())
  journal.recordDispatch(operationId)
  const ambiguous = new WorktreeHandoffJournal(second.path, { now: clock() }).get(operationId)!
  assert.equal(worktreeHandoffOperationPhase(ambiguous), 'ambiguous')
  assert.equal(ambiguous.events.at(-1)?.reason, 'interrupted-after-dispatch')
})

test('allows only authoritative reconciliation to refine an ambiguous operation', async t => {
  const completed = await fixture()
  t.after(() => rm(completed.root, { recursive: true, force: true }))
  const first = new WorktreeHandoffJournal(completed.path)
  first.begin(input())
  first.recordDispatch(operationId)
  first.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')
  first.recordOutcome(operationId, 'succeeded', 'reconciled-completed')
  assert.equal(worktreeHandoffOperationPhase(first.get(operationId)!), 'succeeded')

  const untouched = await fixture()
  t.after(() => rm(untouched.root, { recursive: true, force: true }))
  const second = new WorktreeHandoffJournal(untouched.path)
  second.begin(input())
  second.recordDispatch(operationId)
  second.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')
  second.recordOutcome(operationId, 'failed', 'reconciled-not-applied')
  assert.equal(worktreeHandoffOperationPhase(second.get(operationId)!), 'failed')

  assert.throws(
    () => second.recordOutcome(operationId, 'succeeded', 'reconciled-completed'),
    (error: WorktreeHandoffJournalError) => error.code === 'DUPLICATE_REQUEST',
  )
})

test('keeps recovery timestamps valid when the system clock moves backwards', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new WorktreeHandoffJournal(path, { now: () => new Date('2030-01-01T00:00:00.000Z') })
  journal.begin(input())
  journal.recordDispatch(operationId)

  const recovered = new WorktreeHandoffJournal(path, { now: () => new Date('2026-01-01T00:00:00.000Z') })
  assert.equal(worktreeHandoffOperationPhase(recovered.get(operationId)!), 'ambiguous')
  assert.equal(new WorktreeHandoffJournal(path).status().available, true)
})

test('fails closed for identifier reuse, corrupt state, and persistence failure', async t => {
  const duplicate = await fixture()
  t.after(() => rm(duplicate.root, { recursive: true, force: true }))
  const journal = new WorktreeHandoffJournal(duplicate.path)
  journal.begin(input())
  assert.throws(
    () => journal.begin(input({ sourceTree: 'f'.repeat(40) })),
    (error: WorktreeHandoffJournalError) => error.code === 'DUPLICATE_REQUEST',
  )

  const corrupt = await fixture()
  t.after(() => rm(corrupt.root, { recursive: true, force: true }))
  await writeFile(corrupt.path, '{"schemaVersion":1,"revision":0,"operations":[{}]}\n')
  const unavailable = new WorktreeHandoffJournal(corrupt.path)
  assert.equal(unavailable.status().available, false)
  assert.throws(() => unavailable.get(operationId),
    (error: WorktreeHandoffJournalError) => error.code === 'DESKTOP_UNAVAILABLE')

  const failing = await fixture()
  t.after(() => rm(failing.root, { recursive: true, force: true }))
  const cannotWrite = new WorktreeHandoffJournal(failing.path, {
    write: () => { throw new Error('disk full') },
  })
  assert.throws(() => cannotWrite.begin(input()),
    (error: WorktreeHandoffJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(cannotWrite.status().revision, 0)
})
