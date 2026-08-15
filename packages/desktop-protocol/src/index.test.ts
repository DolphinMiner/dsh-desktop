import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEvent,
  createRequest,
  DESKTOP_PROTOCOL_VERSION,
  parseCapabilityParams,
  parseCapabilityResult,
  parseConnectApiKeyInput,
  parseDesktopProtocolMessage,
} from './index'

test('round-trips a valid capability request', () => {
  const request = createRequest('request-1', 'desktop.ping', { nonce: 'abc' })

  assert.deepEqual(parseDesktopProtocolMessage(request), request)
  assert.deepEqual(parseCapabilityParams(request.method, request.params), { nonce: 'abc' })
  assert.deepEqual(
    parseCapabilityResult('desktop.ping', { nonce: 'abc', protocolVersion: DESKTOP_PROTOCOL_VERSION }),
    { nonce: 'abc', protocolVersion: DESKTOP_PROTOCOL_VERSION },
  )
})

test('validates connection inputs, snapshots, and desktop events', () => {
  assert.deepEqual(parseConnectApiKeyInput({
    requestId: 'request-2',
    provider: 'linear',
    apiKey: 'secret',
    access: 'read-only',
  }), {
    requestId: 'request-2',
    provider: 'linear',
    apiKey: 'secret',
    access: 'read-only',
  })
  assert.equal(parseConnectApiKeyInput({
    requestId: 'request-2',
    provider: 'linear',
    apiKey: '',
    access: 'read-only',
  }), undefined)
  const event = createEvent('connections.changed', { revision: 4 })
  assert.deepEqual(parseDesktopProtocolMessage(event), event)
})

test('rejects malformed envelopes and capability payloads', () => {
  assert.equal(parseDesktopProtocolMessage({ kind: 'request' }), undefined)
  assert.equal(parseDesktopProtocolMessage({
    channel: 'dsh-desktop',
    version: 99,
    kind: 'cancel',
    id: 'request-1',
  }), undefined)
  assert.equal(parseCapabilityParams('desktop.notify', { title: '' }), undefined)
  assert.equal(parseCapabilityResult('desktop.notify', { delivered: 'yes' }), undefined)
})
