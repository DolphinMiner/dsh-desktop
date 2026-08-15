import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GitMutationJournal, GitMutationJournalError, gitMutationPhase } from './git-mutation-journal'

const operationId = '11111111-1111-4111-8111-111111111111'
const input = {
  operationId,
  sessionId: 'session-1',
  workspaceRoot: '/repo',
  repositoryRoot: '/repo',
  repositoryCommonDir: '/repo/.git',
  kind: 'stage' as const,
  requestedPaths: ['src/example.ts'],
  paths: ['src/example.ts'],
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-mutation-test-'))
  return { root, path: join(root, 'git-mutations.v1.json') }
}

test('persists intent before dispatch and deduplicates an identical operation', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(path, { now: clock() })

  assert.equal(journal.begin(input).created, true)
  assert.equal(journal.begin(input).created, false)
  journal.recordDispatch(operationId)
  journal.recordOutcome(operationId, 'succeeded', 'completed')

  const restored = new GitMutationJournal(path)
  assert.equal(gitMutationPhase(restored.get(operationId)!), 'succeeded')
  assert.deepEqual(restored.get(operationId)?.events.map(event => event.phase), [
    'intent', 'dispatch', 'succeeded',
  ])
})

test('recovers pre-dispatch work as cancelled and dispatched work as ambiguous', async t => {
  const first = await fixture()
  t.after(() => rm(first.root, { recursive: true, force: true }))
  new GitMutationJournal(first.path, { now: clock() }).begin(input)
  assert.equal(gitMutationPhase(new GitMutationJournal(first.path, { now: clock() }).get(operationId)!), 'cancelled')

  const second = await fixture()
  t.after(() => rm(second.root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(second.path, { now: clock() })
  journal.begin(input)
  journal.recordDispatch(operationId)
  const recovered = new GitMutationJournal(second.path, { now: clock() })
  assert.equal(gitMutationPhase(recovered.get(operationId)!), 'ambiguous')
  assert.equal(recovered.get(operationId)?.events.at(-1)?.reason, 'interrupted-after-dispatch')
})

test('keeps recovery timestamps valid when the system clock moves backwards', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(path, { now: () => new Date('2030-01-01T00:00:00.000Z') })
  journal.begin(input)
  journal.recordDispatch(operationId)

  const recovered = new GitMutationJournal(path, { now: () => new Date('2026-01-01T00:00:00.000Z') })
  assert.equal(gitMutationPhase(recovered.get(operationId)!), 'ambiguous')
  assert.equal(new GitMutationJournal(path).status().available, true)
})

test('migrates the published v1 index journal before accepting destructive operations', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    operations: [{
      ...input,
      events: [
        { phase: 'intent', at: '2026-08-16T12:00:00.000Z' },
        { phase: 'dispatch', at: '2026-08-16T12:00:01.000Z' },
        { phase: 'succeeded', reason: 'completed', at: '2026-08-16T12:00:02.000Z' },
      ],
    }],
  }, null, 2)}\n`)

  const journal = new GitMutationJournal(path)
  assert.equal(journal.status().available, true)
  assert.equal(journal.status().revision, 8)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 3)
  assert.equal(gitMutationPhase(journal.get(operationId)!), 'succeeded')

  const revertId = '22222222-2222-4222-8222-222222222222'
  assert.equal(journal.begin({
    ...input,
    operationId: revertId,
    kind: 'revert',
    approval: { id: revertId, fingerprint: 'a'.repeat(64) },
  }).created, true)
})

test('fails closed instead of overflowing the revision during v1 migration', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = `${JSON.stringify({
    schemaVersion: 1,
    revision: Number.MAX_SAFE_INTEGER,
    operations: [],
  })}\n`
  await writeFile(path, original)

  const journal = new GitMutationJournal(path)
  assert.equal(journal.status().available, false)
  assert.equal(await readFile(path, 'utf8'), original)
})

test('migrates the published v2 revert journal without weakening approval evidence', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const revertId = '22222222-2222-4222-8222-222222222222'
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 2,
    revision: 4,
    operations: [{
      ...input,
      operationId: revertId,
      kind: 'revert',
      approval: { id: revertId, fingerprint: 'a'.repeat(64) },
      events: [
        { phase: 'intent', at: '2026-08-16T12:00:00.000Z' },
        { phase: 'dispatch', at: '2026-08-16T12:00:01.000Z' },
        { phase: 'succeeded', reason: 'completed', at: '2026-08-16T12:00:02.000Z' },
      ],
    }],
  })}\n`)

  const journal = new GitMutationJournal(path)
  assert.equal(journal.status().available, true)
  assert.equal(journal.status().revision, 5)
  assert.equal(journal.get(revertId)?.approval?.fingerprint, 'a'.repeat(64))
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 3)
})

test('persists the reviewed commit payload and resulting commit identity', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(path)
  const commitId = '33333333-3333-4333-8333-333333333333'
  const commit = {
    message: 'feat: durable commit',
    expectedHead: 'a'.repeat(40),
    expectedTree: 'b'.repeat(40),
    stagedFingerprint: 'c'.repeat(64),
  }

  journal.begin({ ...input, operationId: commitId, kind: 'commit', commit })
  journal.recordDispatch(commitId)
  journal.recordOutcome(commitId, 'succeeded', 'completed', 'd'.repeat(40))
  const restored = new GitMutationJournal(path)
  assert.deepEqual(restored.get(commitId)?.commit, commit)
  assert.equal(restored.get(commitId)?.resultCommit, 'd'.repeat(40))
  assert.equal(restored.begin({ ...input, operationId: commitId, kind: 'commit', commit }).created, false)
})

test('requires immutable approval evidence only for destructive revert intents', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(path)

  assert.throws(() => journal.begin({ ...input, kind: 'revert' }),
    (error: GitMutationJournalError) => error.code === 'BAD_MESSAGE')
  assert.throws(() => journal.begin({
    ...input,
    approval: { id: operationId, fingerprint: 'a'.repeat(64) },
  }), (error: GitMutationJournalError) => error.code === 'BAD_MESSAGE')
})

test('fails closed on corrupt state and persistence failure', async t => {
  const corrupt = await fixture()
  t.after(() => rm(corrupt.root, { recursive: true, force: true }))
  await writeFile(corrupt.path, '{"schemaVersion":1,"revision":3,"operations":[{"paths":["private"]}]}')
  const unavailable = new GitMutationJournal(corrupt.path)
  assert.equal(unavailable.status().available, false)
  assert.throws(() => unavailable.begin(input),
    (error: GitMutationJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.match(await readFile(corrupt.path, 'utf8'), /private/)

  const failing = await fixture()
  t.after(() => rm(failing.root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(failing.path, { write: () => { throw new Error('disk full') } })
  assert.throws(() => journal.begin(input),
    (error: GitMutationJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.deepEqual(journal.status(), {
    available: false,
    revision: 0,
    message: 'The Git mutation journal could not be persisted safely.',
  })
})

test('rejects reuse of an operation identifier for another payload', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitMutationJournal(path)
  journal.begin(input)
  assert.throws(() => journal.begin({ ...input, paths: ['other.ts'] }),
    (error: GitMutationJournalError) => error.code === 'DUPLICATE_REQUEST')
})
