import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  GitRepositoryIdentity,
  GitReviewSnapshot,
  GitReviewTurnAttribution,
  GitTurnEndBoundaryParams,
  GitTurnStartBoundaryParams,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  GitTurnAttributionError,
  GitTurnAttributionService,
  type GitTurnAttributionOperations,
} from './git-turn-attribution'
import { GitTurnAttributionJournal } from './git-turn-attribution-journal'

const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }

function start(turn: number, eventSeq: number): GitTurnStartBoundaryParams {
  return {
    sessionId: 'session-1',
    workspaceRoot: '/repo/nested',
    turn,
    eventSeq,
    eventTime: 1_787_000_000_000 + eventSeq,
    boundary: 'start',
  }
}

function end(turn: number, eventSeq: number): GitTurnEndBoundaryParams {
  return {
    sessionId: 'session-1',
    workspaceRoot: '/repo/nested',
    turn,
    eventSeq,
    eventTime: 1_787_000_000_000 + eventSeq,
    boundary: 'end',
    reason: 'completed',
  }
}

class FakeGit implements GitTurnAttributionOperations {
  readonly captureRoots: string[] = []
  readonly reviews: Array<{ fromTree: string; toTree: string; attribution: GitReviewTurnAttribution }> = []
  captures: Array<{ repository: GitRepositoryIdentity; tree: string } | Error> = []

  async discoverRepository(): Promise<GitRepositoryIdentity> {
    return repository
  }

  async captureWorkingTree(root: string): Promise<{ repository: GitRepositoryIdentity; tree: string }> {
    this.captureRoots.push(root)
    const result = this.captures.shift()
    if (result instanceof Error) throw result
    if (result === undefined) throw new Error('missing capture')
    return result
  }

  async reviewTreeRange(
    _root: string,
    fromTree: string,
    toTree: string,
    attribution: GitReviewTurnAttribution,
  ): Promise<GitReviewSnapshot> {
    this.reviews.push({ fromTree, toTree, attribution })
    return {
      repository,
      scope: { kind: 'completed-turn' },
      fromTree,
      toTree,
      attributedTurn: attribution,
      files: [{ status: 'modified', path: 'README.md', patchAvailable: true }],
      patch: 'diff --git a/README.md b/README.md\n',
    }
  }
}

test('captures and reviews the exact last completed turn from a nested workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = new FakeGit()
  fake.captures.push(
    { repository, tree: 'a'.repeat(40) },
    { repository, tree: 'b'.repeat(40) },
  )
  const authorizations: string[] = []
  const service = new GitTurnAttributionService(
    fake,
    new GitTurnAttributionJournal(join(root, 'turns.json')),
    (sessionId, workspaceRoot, signal) => {
      assert.equal(signal.aborted, false)
      authorizations.push(`${sessionId}:${workspaceRoot}`)
    },
  )
  const signal = new AbortController().signal

  assert.deepEqual(await service.reportBoundary(start(1, 10), signal), { accepted: true, state: 'started' })
  assert.deepEqual(await service.reportBoundary(end(1, 20), signal), { accepted: true, state: 'captured' })
  const review = await service.reviewCompletedTurn({
    sessionId: 'session-1',
    workspaceRoot: '/repo/nested',
    repositoryRoot: '/repo',
    scope: { kind: 'completed-turn' },
  }, repository, signal)

  assert.deepEqual(fake.captureRoots, ['/repo', '/repo'])
  assert.equal(review.fromTree, 'a'.repeat(40))
  assert.equal(review.toTree, 'b'.repeat(40))
  assert.equal(review.attributedTurn?.turn, 1)
  assert.equal(fake.reviews.length, 1)
  assert.equal(authorizations.length, 6)
})

test('serializes duplicate start reports and captures the baseline once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = new FakeGit()
  fake.captures.push({ repository, tree: 'a'.repeat(40) })
  const service = new GitTurnAttributionService(
    fake,
    new GitTurnAttributionJournal(join(root, 'turns.json')),
    () => undefined,
  )
  const signal = new AbortController().signal

  const [first, duplicate] = await Promise.all([
    service.reportBoundary(start(1, 10), signal),
    service.reportBoundary(start(1, 10), signal),
  ])
  assert.deepEqual(first, { accepted: true, state: 'started' })
  assert.deepEqual(duplicate, { accepted: true, state: 'duplicate' })
  assert.equal(fake.captureRoots.length, 1)
})

test('does not fall back to an older turn when the latest completed turn is unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = new FakeGit()
  fake.captures.push(
    { repository, tree: 'a'.repeat(40) },
    { repository, tree: 'b'.repeat(40) },
    new Error('capture failed'),
  )
  const service = new GitTurnAttributionService(
    fake,
    new GitTurnAttributionJournal(join(root, 'turns.json')),
    () => undefined,
  )
  const signal = new AbortController().signal
  await service.reportBoundary(start(1, 10), signal)
  await service.reportBoundary(end(1, 20), signal)
  assert.deepEqual(await service.reportBoundary(start(2, 30), signal), {
    accepted: false,
    state: 'unavailable',
  })
  assert.deepEqual(await service.reportBoundary(end(2, 40), signal), {
    accepted: false,
    state: 'unavailable',
  })

  await assert.rejects(service.reviewCompletedTurn({
    sessionId: 'session-1',
    workspaceRoot: '/repo/nested',
    repositoryRoot: '/repo',
    scope: { kind: 'completed-turn' },
  }, repository, signal), (error: GitTurnAttributionError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(fake.reviews.length, 0)
})

test('marks a changed repository identity unavailable at the end boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-turn-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = new FakeGit()
  fake.captures.push(
    { repository, tree: 'a'.repeat(40) },
    { repository: { ...repository, commonDir: '/repo/.git-replaced' }, tree: 'b'.repeat(40) },
  )
  const journal = new GitTurnAttributionJournal(join(root, 'turns.json'))
  const service = new GitTurnAttributionService(fake, journal, () => undefined)
  const signal = new AbortController().signal
  await service.reportBoundary(start(1, 10), signal)

  assert.deepEqual(await service.reportBoundary(end(1, 20), signal), {
    accepted: false,
    state: 'unavailable',
  })
  assert.equal(journal.latestCompleted('session-1', '/repo/nested')?.unavailableReason, 'repository-changed')
})
