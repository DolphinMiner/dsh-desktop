import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitTurnBoundaryParams } from '@dolphinminer/dsh-desktop-protocol'

import { GitTurnBoundaryCoordinator, reportTurnBoundaryAndActivity } from './git-turn-boundary.js'

function boundary(
  kind: 'start' | 'end',
  turn: number,
  eventSeq: number,
): GitTurnBoundaryParams {
  const base = {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    turn,
    eventSeq,
    eventTime: 1_787_000_000_000 + eventSeq,
  }
  return kind === 'start'
    ? { ...base, boundary: 'start' }
    : { ...base, boundary: 'end', reason: 'completed' }
}

test('waits for the current turn baseline once before tool dispatch', async () => {
  const reports: string[] = []
  const coordinator = new GitTurnBoundaryCoordinator(async params => {
    reports.push(`${params.boundary}:${String(params.turn)}`)
  })
  const event = {
    type: 'turn/start',
    seq: 10,
    time: 1_787_000_000_010,
    data: { turn: 1 },
  } as const
  const agent = {
    id: 'session-1',
    session: { id: 'session-1', header: { cwd: '/repo' }, events: [event] },
  }

  await Promise.all([coordinator.beforeTool(agent as never), coordinator.beforeTool(agent as never)])
  assert.deepEqual(reports, ['start:1'])
})

test('serializes end capture before the next turn baseline', async () => {
  const reports: string[] = []
  let releaseStart: () => void
  const startGate = new Promise<void>(resolve => { releaseStart = resolve })
  const coordinator = new GitTurnBoundaryCoordinator(async params => {
    reports.push(`begin:${params.boundary}:${String(params.turn)}`)
    if (params.boundary === 'start' && params.turn === 1) await startGate
    reports.push(`end:${params.boundary}:${String(params.turn)}`)
  })

  const first = coordinator.observe(boundary('start', 1, 10))
  const end = coordinator.observe(boundary('end', 1, 20))
  const second = coordinator.observe(boundary('start', 2, 30))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reports, ['begin:start:1'])
  releaseStart!()
  await Promise.all([first, end, second])
  assert.deepEqual(reports, [
    'begin:start:1',
    'end:start:1',
    'begin:end:1',
    'end:end:1',
    'begin:start:2',
    'end:start:2',
  ])
})

test('contains boundary failures so ordinary tools can continue', async () => {
  const errors: string[] = []
  const coordinator = new GitTurnBoundaryCoordinator(
    async () => { throw new Error('desktop unavailable') },
    error => errors.push(error instanceof Error ? error.message : String(error)),
  )
  const event = {
    type: 'turn/start',
    seq: 10,
    time: 1_787_000_000_010,
    data: { turn: 1 },
  } as const
  await coordinator.beforeTool({
    id: 'session-1',
    session: { id: 'session-1', header: { cwd: '/repo' }, events: [event] },
  } as never)
  assert.deepEqual(errors, ['desktop unavailable'])
})

test('still records the Git boundary when session activity reporting fails', async () => {
  const calls: string[] = []
  const activityError = new Error('activity unavailable')

  await assert.rejects(reportTurnBoundaryAndActivity(
    boundary('end', 1, 20),
    async () => {
      calls.push('activity')
      throw activityError
    },
    async () => {
      calls.push('boundary')
    },
  ), error => error === activityError)
  assert.deepEqual(calls, ['activity', 'boundary'])
})
