import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AutomationScheduleError,
  isAutomationOccurrence,
  latestDueAutomationOccurrence,
  nextAutomationOccurrence,
  validateAutomationTrigger,
} from './automation-schedule'

test('validates deterministic five-field cron expressions and IANA time zones', () => {
  assert.doesNotThrow(() => validateAutomationTrigger({
    kind: 'cron',
    expression: '0 9 * * 1-5',
    timeZone: 'Asia/Shanghai',
  }))
  assert.throws(() => validateAutomationTrigger({
    kind: 'cron',
    expression: '0 9 * * * *',
    timeZone: 'UTC',
  }), (error: AutomationScheduleError) => error.code === 'INVALID_TRIGGER')
  assert.throws(() => validateAutomationTrigger({
    kind: 'cron',
    expression: 'H 9 * * *',
    timeZone: 'UTC',
  }), (error: AutomationScheduleError) => error.code === 'INVALID_TRIGGER')
  assert.throws(() => validateAutomationTrigger({
    kind: 'cron',
    expression: '0 9 * * *',
    timeZone: 'Mars/Olympus_Mons',
  }), (error: AutomationScheduleError) => error.code === 'INVALID_TRIGGER')
})

test('skips a nonexistent daylight-saving wall time', () => {
  const trigger = {
    kind: 'cron' as const,
    expression: '30 2 * * *',
    timeZone: 'America/New_York',
  }
  assert.equal(
    nextAutomationOccurrence(trigger, '2026-03-07T07:30:00.000Z'),
    '2026-03-09T06:30:00.000Z',
  )
  assert.equal(
    latestDueAutomationOccurrence(trigger, '2026-03-07T07:30:00.000Z', '2026-03-08T20:00:00.000Z'),
    '2026-03-07T07:30:00.000Z',
  )
})

test('uses only the earlier occurrence of a repeated daylight-saving wall time', () => {
  const trigger = {
    kind: 'cron' as const,
    expression: '30 1 * * *',
    timeZone: 'America/New_York',
  }
  assert.equal(
    nextAutomationOccurrence(trigger, '2026-10-31T05:30:00.000Z'),
    '2026-11-01T05:30:00.000Z',
  )
  assert.equal(
    nextAutomationOccurrence(trigger, '2026-11-01T05:30:00.000Z'),
    '2026-11-02T06:30:00.000Z',
  )
  assert.equal(
    latestDueAutomationOccurrence(trigger, '2026-10-31T05:30:00.000Z', '2026-11-01T07:00:00.000Z'),
    '2026-11-01T05:30:00.000Z',
  )
  assert.equal(isAutomationOccurrence(trigger, '2026-11-01T05:30:00.000Z'), true)
  assert.equal(isAutomationOccurrence(trigger, '2026-11-01T06:30:00.000Z'), false)
})

test('returns only the latest missed recurring occurrence', () => {
  const trigger = { kind: 'cron' as const, expression: '0 9 * * *', timeZone: 'Asia/Shanghai' }
  assert.equal(
    latestDueAutomationOccurrence(trigger, '2026-08-14T01:00:00.000Z', '2026-08-16T03:00:00.000Z'),
    '2026-08-16T01:00:00.000Z',
  )
  assert.equal(
    latestDueAutomationOccurrence(trigger, '2026-08-17T01:00:00.000Z', '2026-08-16T03:00:00.000Z'),
    undefined,
  )
})

test('keeps one-shot scheduling explicit and bounded', () => {
  const trigger = { kind: 'once' as const, at: '2026-08-17T01:00:00.000Z' }
  assert.equal(nextAutomationOccurrence(trigger, '2026-08-16T01:00:00.000Z'), trigger.at)
  assert.equal(nextAutomationOccurrence(trigger, trigger.at), undefined)
  assert.equal(latestDueAutomationOccurrence(trigger, trigger.at, trigger.at), trigger.at)
  assert.equal(latestDueAutomationOccurrence(trigger, trigger.at, '2026-08-16T01:00:00.000Z'), undefined)
  assert.throws(() => validateAutomationTrigger({ kind: 'once', at: '2026-08-17T01:00:00Z' }),
    (error: AutomationScheduleError) => error.code === 'INVALID_TRIGGER')
})
