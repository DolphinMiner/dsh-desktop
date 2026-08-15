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
  parseComputerObservation,
  parseComputerPermissions,
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
  assert.deepEqual(parseCapabilityParams('desktop.revealPath', {
    sessionId: 'session-1',
    workspaceRoot: '/tmp/project',
    path: 'README.md',
  }), {
    sessionId: 'session-1',
    workspaceRoot: '/tmp/project',
    path: 'README.md',
  })
  assert.equal(parseCapabilityParams('desktop.openPath', {
    sessionId: '',
    workspaceRoot: '/tmp/project',
    path: 'README.md',
  }), undefined)
  assert.deepEqual(parseCapabilityResult('desktop.openPath', {
    opened: true,
    path: '/tmp/project/README.md',
  }), {
    opened: true,
    path: '/tmp/project/README.md',
  })
})

test('validates bounded computer permissions and observations', () => {
  assert.deepEqual(parseComputerPermissions({
    supported: true,
    screenRecording: 'granted',
    accessibility: 'denied',
    canObserve: true,
  }), {
    supported: true,
    screenRecording: 'granted',
    accessibility: 'denied',
    canObserve: true,
  })
  assert.equal(parseComputerPermissions({
    supported: true,
    screenRecording: 'denied',
    accessibility: 'granted',
    canObserve: true,
  }), undefined)

  const observation = {
    version: 1,
    snapshotId: 'snapshot-1',
    observedAt: '2026-08-16T12:00:00.000Z',
    target: { id: 'window:7', kind: 'window', name: 'Editor' },
    capture: {
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      displayScale: 2,
      pixelWidth: 1600,
      pixelHeight: 1200,
      screenshotCaptured: true,
      ocrText: 'README.md',
    },
    elements: [{
      id: 'ax:0',
      role: 'AXTextField',
      actions: ['AXPress'],
      secure: false,
      value: 'README.md',
    }],
    truncated: false,
    warnings: [],
  }
  assert.deepEqual(parseComputerObservation(observation), observation)
  assert.equal(parseComputerObservation({
    ...observation,
    elements: [{ id: 'ax:0', role: 'AXSecureTextField', actions: [], secure: true, value: 'secret' }],
  }), undefined)
  assert.deepEqual(parseCapabilityParams('computer.observe', { sessionId: 'session-1' }), {
    sessionId: 'session-1',
  })
  assert.deepEqual(parseCapabilityResult('computer.observe', observation), observation)
})
