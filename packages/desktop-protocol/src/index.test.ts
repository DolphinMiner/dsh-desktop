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
  parseRendererCommand,
  isLikelyReadOnlyMcpTool,
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
  assert.equal(isLikelyReadOnlyMcpTool('list_issues'), true)
  assert.equal(isLikelyReadOnlyMcpTool('create_issue'), false)
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

test('validates desktop commands and session activity reports', () => {
  assert.deepEqual(parseRendererCommand({ type: 'session.open', sessionId: 'session-1' }), {
    type: 'session.open',
    sessionId: 'session-1',
  })
  assert.deepEqual(parseRendererCommand({ type: 'settings.open', sectionId: 'connections' }), {
    type: 'settings.open',
    sectionId: 'connections',
  })
  assert.equal(parseRendererCommand({ type: 'session.open', sessionId: '' }), undefined)
  assert.deepEqual(parseCapabilityParams('desktop.reportSessionActivity', {
    sessionId: 'session-1',
    eventSeq: 17,
    running: true,
    workspacePath: '/tmp/project',
  }), {
    sessionId: 'session-1',
    eventSeq: 17,
    running: true,
    workspacePath: '/tmp/project',
  })
  assert.equal(parseCapabilityParams('desktop.reportSessionActivity', {
    sessionId: 'session-1',
    eventSeq: -1,
    running: true,
  }), undefined)
  assert.deepEqual(parseCapabilityResult('desktop.reportSessionActivity', { accepted: true }), {
    accepted: true,
  })
})
