import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopActivityTracker } from './desktop-activity'

test('tracks authoritative running edges and rejects stale activity', () => {
  const snapshots: string[][] = []
  const tracker = new DesktopActivityTracker(snapshot => {
    snapshots.push([...snapshot.runningSessionIds])
  })

  assert.equal(tracker.report({ sessionId: 'one', eventSeq: 10, running: true }), true)
  assert.equal(tracker.report({ sessionId: 'one', eventSeq: 9, running: false }), false)
  assert.deepEqual(tracker.snapshot().runningSessionIds, ['one'])
  assert.equal(tracker.report({ sessionId: 'one', eventSeq: 11, running: false }), true)
  assert.deepEqual(tracker.snapshot().runningSessionIds, [])
  assert.deepEqual(snapshots, [['one'], []])
})

test('authorizes only the exact workspace of a running session', () => {
  const tracker = new DesktopActivityTracker(() => undefined)
  tracker.report({ sessionId: 'one', eventSeq: 1, running: true, workspacePath: '/repo' })
  assert.equal(tracker.isRunningInWorkspace('one', '/repo'), true)
  assert.equal(tracker.isRunningInWorkspace('one', '/other'), false)
  assert.equal(tracker.isRunningInWorkspace('two', '/repo'), false)
  tracker.report({ sessionId: 'one', eventSeq: 2, running: false, workspacePath: '/repo' })
  assert.equal(tracker.isRunningInWorkspace('one', '/repo'), false)
})

test('clears all running state when the Harness lifecycle ends', () => {
  const tracker = new DesktopActivityTracker(() => undefined)
  tracker.report({ sessionId: 'one', eventSeq: 1, running: true, workspacePath: '/repo' })
  tracker.clear()
  assert.deepEqual(tracker.snapshot(), { runningSessionIds: [], workspacePaths: {} })
})
