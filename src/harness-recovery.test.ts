import assert from 'node:assert/strict'
import test from 'node:test'

import { HarnessRecoveryController, HarnessRecoverySchedule } from './harness-recovery'

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

test('restarts with bounded backoff and stops after the retry budget', async () => {
  const schedules: HarnessRecoverySchedule[] = []
  let starts = 0
  let exhausted = 0
  const recovery = new HarnessRecoveryController({
    start: async () => { starts += 1 },
    onSchedule: schedule => schedules.push(schedule),
    onExhausted: attempts => { exhausted = attempts },
    delaysMs: [2, 2],
    failureWindowMs: 1_000,
  })

  recovery.handleUnexpectedFailure()
  await delay(8)
  recovery.handleUnexpectedFailure()
  await delay(8)
  recovery.handleUnexpectedFailure()

  assert.equal(starts, 2)
  assert.deepEqual(schedules.map(schedule => schedule.attempt), [1, 2])
  assert.equal(exhausted, 2)
  recovery.stop()
})

test('manual retry cancels a pending timer and resets the failure budget', async () => {
  let starts = 0
  const attempts: number[] = []
  const recovery = new HarnessRecoveryController({
    start: async () => { starts += 1 },
    onSchedule: schedule => attempts.push(schedule.attempt),
    onExhausted: () => assert.fail('retry budget should not be exhausted'),
    delaysMs: [50, 50],
  })

  recovery.handleUnexpectedFailure()
  await recovery.restartNow()
  await delay(60)
  recovery.handleUnexpectedFailure()

  assert.equal(starts, 1)
  assert.deepEqual(attempts, [1, 1])
  recovery.stop()
})

test('a rejected restart consumes the next attempt without an unhandled rejection', async () => {
  let starts = 0
  let errors = 0
  const recovery = new HarnessRecoveryController({
    start: async () => {
      starts += 1
      if (starts === 1) throw new Error('launch failed')
    },
    onSchedule: () => undefined,
    onExhausted: () => assert.fail('retry budget should not be exhausted'),
    onStartError: () => { errors += 1 },
    delaysMs: [2, 2],
  })

  recovery.handleUnexpectedFailure()
  await delay(15)

  assert.equal(starts, 2)
  assert.equal(errors, 1)
  recovery.stop()
})
