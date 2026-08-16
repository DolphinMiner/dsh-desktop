import assert from 'node:assert/strict'
import test from 'node:test'

import type { AutomationRunSummary, AutomationRunTerminalPhase } from '@dolphinminer/dsh-desktop-protocol'

import { automationNotificationContent, automationRunHasSession } from './automation-notification'

function run(phase: AutomationRunSummary['phase']): AutomationRunSummary {
  const terminal = phase === 'succeeded' || phase === 'failed' || phase === 'cancelled' ||
    phase === 'interrupted' || phase === 'ambiguous'
  return {
    id: '11111111-1111-4111-8111-111111111111',
    automationId: '22222222-2222-4222-8222-222222222222',
    payloadHash: 'a'.repeat(64),
    payload: {
      definitionRevision: 1,
      definitionName: 'Sensitive customer task',
      prompt: 'Do the work.',
      projectPath: '/repo',
      repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
      trigger: { kind: 'once', at: '2026-08-17T01:00:00.000Z' },
      execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
      concurrencyPolicy: 'skip',
      skillIds: [],
      connectionIds: [],
      invocation: { kind: 'manual', requestedAt: '2026-08-17T01:00:00.000Z' },
      sessionId: '33333333-3333-4333-8333-333333333333',
    },
    phase,
    cancellationRequested: phase === 'cancelled',
    createdAt: '2026-08-17T01:00:00.000Z',
    updatedAt: terminal ? '2026-08-17T01:00:01.000Z' : '2026-08-17T01:00:00.000Z',
    events: [
      { seq: 1, operationId: 'queue', at: '2026-08-17T01:00:00.000Z', type: 'queued' },
      ...(terminal ? [{
        seq: 2,
        operationId: 'finish',
        at: '2026-08-17T01:00:01.000Z',
        type: 'terminal' as const,
        outcome: phase as AutomationRunTerminalPhase,
      }] : []),
    ],
  }
}

test('uses truthful, privacy-preserving terminal automation notifications', () => {
  assert.equal(automationNotificationContent(run('running')), undefined)
  const succeeded = automationNotificationContent(run('succeeded'))
  assert.equal(succeeded?.title, 'Automation finished')
  assert.match(succeeded?.body ?? '', /Review/)
  assert.doesNotMatch(JSON.stringify(succeeded), /Sensitive customer task/)
  assert.match(automationNotificationContent(run('ambiguous'))?.body ?? '', /before retrying/)
  assert.match(automationNotificationContent(run('failed'))?.body ?? '', /failed/)
  assert.match(automationNotificationContent(run('cancelled'))?.body ?? '', /cancelled/)
})

test('routes pre-session failures to Task Center instead of a nonexistent session', () => {
  const failed = run('failed')
  assert.equal(automationRunHasSession(failed), false)
  assert.match(automationNotificationContent(failed)?.body ?? '', /Task Center/)
  failed.events.splice(1, 0, {
    seq: 2,
    operationId: 'running',
    at: '2026-08-17T01:00:00.500Z',
    type: 'running',
    sessionEventSeq: 1,
  })
  failed.events[2]!.seq = 3
  assert.equal(automationRunHasSession(failed), true)
  assert.match(automationNotificationContent(failed)?.body ?? '', /session/)
})
