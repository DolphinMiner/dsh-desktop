import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  WorktreeRelocationJournal,
  WorktreeRelocationJournalError,
  worktreeRelocationPhase,
  type BeginWorktreeRelocationInput,
} from './worktree-relocation-journal'

const operationId = '11111111-1111-4111-8111-111111111111'
const worktreeId = '22222222-2222-4222-8222-222222222222'

function input(overrides: Partial<BeginWorktreeRelocationInput> = {}): BeginWorktreeRelocationInput {
  return {
    operationId,
    worktreeId,
    repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
    inspection: {
      repositoryRoot: '/repo',
      registeredPath: '/managed/original',
      current: {
        worktreePath: '/managed/moved',
        head: 'a'.repeat(40),
        branch: 'refs/heads/dsh/session-123456789012345678901234',
        clean: false,
        locked: true,
        changes: [{
          kind: 'untracked',
          path: 'notes.txt',
          indexStatus: '?',
          worktreeStatus: '?',
        }],
      },
      registeredPathAbsent: true,
    },
    fingerprint: 'b'.repeat(64),
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-relocation-journal-test-'))
  return { root, path: join(root, 'worktree-relocations.v1.json') }
}

test('persists exact moved-checkout evidence before dispatch and deduplicates retries', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new WorktreeRelocationJournal(path, { now: clock() })

  assert.equal(journal.begin(input()).created, true)
  assert.equal(journal.begin(input()).created, false)
  journal.recordDispatch(operationId)
  journal.recordOutcome(operationId, 'succeeded', 'completed')

  const restored = new WorktreeRelocationJournal(path)
  const operation = restored.get(operationId)!
  assert.equal(worktreeRelocationPhase(operation), 'succeeded')
  assert.deepEqual(operation.events.map(event => event.phase), ['intent', 'dispatch', 'succeeded'])
  assert.equal(operation.inspection.current.worktreePath, '/managed/moved')
  assert.deepEqual(operation.inspection.current.changes.map(change => change.path), ['notes.txt'])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 1)
})

test('turns interrupted intent and dispatch into durable no-replay states', async t => {
  const beforeDispatch = await fixture()
  t.after(() => rm(beforeDispatch.root, { recursive: true, force: true }))
  new WorktreeRelocationJournal(beforeDispatch.path, { now: clock() }).begin(input())
  const cancelled = new WorktreeRelocationJournal(beforeDispatch.path, { now: clock() }).get(operationId)!
  assert.equal(worktreeRelocationPhase(cancelled), 'cancelled')
  assert.equal(cancelled.events.at(-1)?.reason, 'interrupted-before-dispatch')

  const afterDispatch = await fixture()
  t.after(() => rm(afterDispatch.root, { recursive: true, force: true }))
  const journal = new WorktreeRelocationJournal(afterDispatch.path, { now: clock() })
  journal.begin(input())
  journal.recordDispatch(operationId)
  const ambiguous = new WorktreeRelocationJournal(afterDispatch.path, { now: clock() }).get(operationId)!
  assert.equal(worktreeRelocationPhase(ambiguous), 'ambiguous')
  assert.equal(ambiguous.events.at(-1)?.reason, 'interrupted-after-dispatch')
})

test('allows only authoritative reconciliation to refine an ambiguous relocation', async t => {
  const completed = await fixture()
  t.after(() => rm(completed.root, { recursive: true, force: true }))
  const first = new WorktreeRelocationJournal(completed.path)
  first.begin(input())
  first.recordDispatch(operationId)
  first.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')
  first.recordOutcome(operationId, 'succeeded', 'reconciled-completed')
  assert.equal(worktreeRelocationPhase(first.get(operationId)!), 'succeeded')

  const notApplied = await fixture()
  t.after(() => rm(notApplied.root, { recursive: true, force: true }))
  const second = new WorktreeRelocationJournal(notApplied.path)
  second.begin(input())
  second.recordDispatch(operationId)
  second.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')
  second.recordOutcome(operationId, 'failed', 'reconciled-not-applied')
  assert.equal(worktreeRelocationPhase(second.get(operationId)!), 'failed')
  assert.throws(
    () => second.recordOutcome(operationId, 'succeeded', 'reconciled-completed'),
    (error: WorktreeRelocationJournalError) => error.code === 'DUPLICATE_REQUEST',
  )
})

test('blocks a second operation while the same checkout has an unresolved outcome', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new WorktreeRelocationJournal(path)
  journal.begin(input())
  journal.recordDispatch(operationId)
  journal.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')

  assert.throws(
    () => journal.begin(input({ operationId: '33333333-3333-4333-8333-333333333333' })),
    (error: WorktreeRelocationJournalError) => error.code === 'DUPLICATE_REQUEST' && /unresolved/.test(error.message),
  )
})

test('fails closed for identity reuse, corrupt state, and persistence failure', async t => {
  const duplicate = await fixture()
  t.after(() => rm(duplicate.root, { recursive: true, force: true }))
  const journal = new WorktreeRelocationJournal(duplicate.path)
  journal.begin(input())
  assert.throws(
    () => journal.begin(input({ fingerprint: 'c'.repeat(64) })),
    (error: WorktreeRelocationJournalError) => error.code === 'DUPLICATE_REQUEST',
  )

  const corrupt = await fixture()
  t.after(() => rm(corrupt.root, { recursive: true, force: true }))
  await writeFile(corrupt.path, '{"schemaVersion":1,"revision":0,"operations":[{}]}\n')
  const unavailable = new WorktreeRelocationJournal(corrupt.path)
  assert.equal(unavailable.status().available, false)
  assert.throws(() => unavailable.get(operationId),
    (error: WorktreeRelocationJournalError) => error.code === 'DESKTOP_UNAVAILABLE')

  const overlap = await fixture()
  t.after(() => rm(overlap.root, { recursive: true, force: true }))
  const overlappingJournal = new WorktreeRelocationJournal(overlap.path)
  overlappingJournal.begin(input())
  overlappingJournal.recordDispatch(operationId)
  overlappingJournal.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')
  const document = JSON.parse(await readFile(overlap.path, 'utf8')) as {
    operations: Array<Record<string, unknown>>
  }
  document.operations.push({
    ...structuredClone(document.operations[0]!),
    operationId: '33333333-3333-4333-8333-333333333333',
  })
  await writeFile(overlap.path, `${JSON.stringify(document)}\n`)
  assert.equal(new WorktreeRelocationJournal(overlap.path).status().available, false)

  const failing = await fixture()
  t.after(() => rm(failing.root, { recursive: true, force: true }))
  const cannotWrite = new WorktreeRelocationJournal(failing.path, {
    write: () => { throw new Error('disk full') },
  })
  assert.throws(() => cannotWrite.begin(input()),
    (error: WorktreeRelocationJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(cannotWrite.status().revision, 0)
})
