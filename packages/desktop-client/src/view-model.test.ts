import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canReconnect,
  computerPermissionLabel,
  computerTargetGroupLabel,
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

test('maps computer permissions and target kinds to truthful labels', () => {
  assert.equal(computerPermissionLabel('granted'), 'Allowed')
  assert.equal(computerPermissionLabel('denied'), 'Not allowed')
  assert.equal(computerPermissionLabel('not-determined'), 'Not requested')
  assert.equal(computerTargetGroupLabel('window'), 'Windows')
  assert.equal(computerTargetGroupLabel('display'), 'Displays')
})
