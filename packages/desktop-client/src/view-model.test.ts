import assert from 'node:assert/strict'
import test from 'node:test'

import {
  automationRunPhaseLabel,
  automationRunStateDot,
  automationStateDot,
  automationStateLabel,
  canReconnect,
  computerActionStatusLabel,
  computerPermissionLabel,
  connectionStateDot,
  connectionStatusLabel,
} from './view-model.js'

test('maps connection state to truthful status presentation', () => {
  assert.equal(connectionStateDot('connected'), 'done')
  assert.equal(connectionStateDot('connecting'), 'ongoing')
  assert.equal(connectionStateDot('expired'), 'warning')
  assert.equal(connectionStateDot('error'), 'error')
  assert.equal(connectionStatusLabel('disconnected'), 'Disconnected')
  assert.equal(canReconnect('connected'), false)
  assert.equal(canReconnect('expired'), true)
})

test('maps computer permissions and action outcomes to truthful labels', () => {
  assert.equal(computerPermissionLabel('granted'), 'Allowed')
  assert.equal(computerPermissionLabel('denied'), 'Not allowed')
  assert.equal(computerPermissionLabel('not-determined'), 'Not requested')
  assert.equal(computerActionStatusLabel('dispatch'), 'Dispatched')
  assert.equal(computerActionStatusLabel('ambiguous'), 'Result uncertain')
})

test('maps durable automation and run state without overstating ambiguous outcomes', () => {
  assert.equal(automationStateLabel('enabled'), 'Scheduled')
  assert.equal(automationStateLabel('paused'), 'Paused')
  assert.equal(automationStateDot('completed'), 'done')
  assert.equal(automationRunPhaseLabel('dispatching'), 'Preparing workspace')
  assert.equal(automationRunPhaseLabel('ambiguous'), 'Outcome uncertain')
  assert.equal(automationRunStateDot('running'), 'ongoing')
  assert.equal(automationRunStateDot('failed'), 'error')
  assert.equal(automationRunStateDot('interrupted'), 'warning')
})
