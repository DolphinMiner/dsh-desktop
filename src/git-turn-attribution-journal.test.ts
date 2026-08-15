import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  GitTurnEndBoundaryParams,
  GitTurnStartBoundaryParams,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  GitTurnAttributionJournal,
  GitTurnAttributionJournalError,
} from './git-turn-attribution-journal'

const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }

function start(turn = 1, eventSeq = 10): GitTurnStartBoundaryParams {
  return {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    turn,
    eventSeq,
    eventTime: 1_787_000_000_000 + eventSeq,
    boundary: 'start',
  }
}

function end(
  turn = 1,
  eventSeq = 20,
  reason: GitTurnEndBoundaryParams['reason'] = 'completed',
): GitTurnEndBoundaryParams {
  return {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    turn,
    eventSeq,
    eventTime: 1_787_000_000_000 + eventSeq,
    boundary: 'end',
    reason,
  }
}

test('persists an idempotent completed-turn attribution lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitTurnAttributionJournal(join(root, 'turns.json'))
  const startBoundary = start()
  const endBoundary = end()

  assert.equal(journal.beginStart(startBoundary).capture, true)
  assert.equal(journal.completeStart(startBoundary, repository, 'a'.repeat(40)).state, 'started')
  assert.equal(journal.beginStart(startBoundary).capture, false)
  assert.equal(journal.beginEnd(endBoundary).capture, true)
  assert.equal(journal.completeEnd(endBoundary, repository, 'b'.repeat(40)).state, 'captured')
  assert.equal(journal.beginEnd(endBoundary).capture, false)

  assert.deepEqual(journal.latestCompleted('session-1', '/repo'), {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    turn: 1,
    state: 'captured',
    startEventSeq: 10,
    startEventTime: 1_787_000_000_010,
    repository,
    startTree: 'a'.repeat(40),
    endEventSeq: 20,
    endEventTime: 1_787_000_000_020,
    endReason: 'completed',
    endTree: 'b'.repeat(40),
    updatedAt: journal.records()[0]!.updatedAt,
  })

  assert.throws(() => journal.beginEnd({ ...endBoundary, eventSeq: 21 }),
    (error: GitTurnAttributionJournalError) => error.code === 'DUPLICATE_REQUEST')
})

test('closes non-completed turns without an end-tree capture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitTurnAttributionJournal(join(root, 'turns.json'))
  const boundary = start()
  journal.beginStart(boundary)
  journal.completeStart(boundary, repository, 'a'.repeat(40))

  const closed = journal.beginEnd(end(1, 20, 'aborted'))
  assert.equal(closed.capture, false)
  assert.equal(closed.record.state, 'not-completed')
  assert.equal(journal.latestCompleted('session-1', '/repo'), undefined)
})

test('records a completed end without a start as unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = new GitTurnAttributionJournal(join(root, 'turns.json'))

  const result = journal.beginEnd(end())
  assert.equal(result.capture, false)
  assert.equal(result.record.state, 'unavailable')
  assert.equal(result.record.unavailableReason, 'missing-start')
  assert.equal(journal.latestCompleted('session-1', '/repo')?.state, 'unavailable')
})

test('cold restart makes incomplete start and end captures unavailable without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const startPath = join(root, 'start.json')
  new GitTurnAttributionJournal(startPath).beginStart(start())
  const recoveredStart = new GitTurnAttributionJournal(startPath).records()[0]!
  assert.equal(recoveredStart.state, 'unavailable')
  assert.equal(recoveredStart.unavailableReason, 'interrupted')

  const endPath = join(root, 'end.json')
  const beforeEnd = new GitTurnAttributionJournal(endPath)
  beforeEnd.beginStart(start())
  beforeEnd.completeStart(start(), repository, 'a'.repeat(40))
  beforeEnd.beginEnd(end())
  const recoveredEnd = new GitTurnAttributionJournal(endPath).records()[0]!
  assert.equal(recoveredEnd.state, 'unavailable')
  assert.equal(recoveredEnd.endReason, 'completed')
  assert.equal(recoveredEnd.unavailableReason, 'interrupted')
})

test('does not invent state after a persistence failure', () => {
  const journal = new GitTurnAttributionJournal('/unused/turns.json', {
    write: () => { throw new Error('disk full') },
  })
  assert.throws(() => journal.beginStart(start()),
    (error: GitTurnAttributionJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(journal.status().available, false)
  assert.throws(() => journal.records(),
    (error: GitTurnAttributionJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
})

test('prunes only terminal records when the bounded journal is full', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-prune-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'turns.json')
  const journal = new GitTurnAttributionJournal(path, { maxRecords: 1 })
  journal.beginEnd(end(1, 10, 'blocked'))
  assert.equal(journal.beginStart(start(2, 20)).capture, true)
  assert.deepEqual(journal.records().map(record => record.turn), [2])

  assert.throws(() => journal.beginStart({ ...start(3, 30), sessionId: 'session-2' }),
    (error: GitTurnAttributionJournalError) => error.code === 'DESKTOP_UNAVAILABLE')
})
