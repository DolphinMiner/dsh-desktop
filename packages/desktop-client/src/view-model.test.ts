import assert from 'node:assert/strict'
import test from 'node:test'

import { canReconnect, connectionStateDot, connectionStatusLabel } from './view-model.js'

test('maps connection state to truthful status presentation', () => {
  assert.equal(connectionStateDot('connected'), 'done')
  assert.equal(connectionStateDot('connecting'), 'ongoing')
  assert.equal(connectionStateDot('expired'), 'warning')
  assert.equal(connectionStateDot('error'), 'error')
  assert.equal(connectionStatusLabel('disconnected'), 'Disconnected')
  assert.equal(canReconnect('connected'), false)
  assert.equal(canReconnect('expired'), true)
})
