import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPUTER_ACTION_VERSION,
  COMPUTER_OBSERVATION_VERSION,
  createEvent,
  createRequest,
  DESKTOP_PROTOCOL_VERSION,
  parseCapabilityParams,
  parseCapabilityResult,
  parseConnectApiKeyInput,
  parseDesktopProtocolMessage,
  parseRendererCommand,
  isLikelyReadOnlyMcpTool,
  parseComputerActParams,
  parseComputerActionResult,
  parseComputerObservation,
  parseComputerPermissions,
  parseSelectComputerTargetInput,
  summarizeComputerAction,
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
    canAct: false,
  }), {
    supported: true,
    screenRecording: 'granted',
    accessibility: 'denied',
    canObserve: true,
    canAct: false,
  })
  assert.equal(parseComputerPermissions({
    supported: true,
    screenRecording: 'denied',
    accessibility: 'granted',
    canObserve: true,
    canAct: false,
  }), undefined)

  const observation = {
    version: COMPUTER_OBSERVATION_VERSION,
    snapshotId: 'snapshot-1',
    observedAt: '2026-08-16T12:00:00.000Z',
    target: { id: 'window:7', kind: 'window', name: 'Editor' },
    foregroundApplication: {
      id: 'application:42',
      name: 'Editor',
      bundleId: 'dev.editor',
      pid: 42,
      frontmost: true,
    },
    compatibility: {
      surfaceId: 'window:7:42',
      surfaceBounds: { x: 10, y: 20, width: 800, height: 600 },
      displayTopology: [{
        id: 'display:1',
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        displayScale: 2,
      }],
      foregroundApplicationId: 'application:42',
    },
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
  assert.equal(parseComputerObservation({
    ...observation,
    compatibility: {
      ...observation.compatibility,
      surfaceBounds: { x: 10, y: 20, width: 799, height: 600 },
    },
  }), undefined)
  assert.deepEqual(parseCapabilityParams('computer.observe', { sessionId: 'session-1' }), {
    sessionId: 'session-1',
  })
  assert.deepEqual(parseCapabilityResult('computer.observe', observation), observation)
  assert.deepEqual(parseSelectComputerTargetInput({ targetId: 'window:7' }), { targetId: 'window:7' })
  assert.equal(parseSelectComputerTargetInput({ targetId: 'window:7', path: '/tmp' }), undefined)
})

test('validates snapshot-bound computer actions without echoing typed text', () => {
  const input = {
    actionId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
    action: {
      kind: 'type',
      elementId: 'ax:0.1',
      text: 'sensitive draft',
      replace: true,
    },
  } as const
  assert.deepEqual(parseComputerActParams(input), input)
  assert.deepEqual(parseCapabilityParams('computer.act', input), input)
  assert.deepEqual(summarizeComputerAction(input.action), {
    kind: 'type',
    elementId: 'ax:0.1',
    textLength: 15,
    replace: true,
  })
  assert.equal(parseComputerActParams({
    ...input,
    action: {
      kind: 'click',
      target: { mode: 'point', coordinateSpace: 'capture', point: { x: -1, y: 30 } },
      button: 'left',
      clickCount: 1,
    },
  }), undefined)

  const observation = {
    version: COMPUTER_OBSERVATION_VERSION,
    snapshotId: 'snapshot-2',
    observedAt: '2026-08-16T12:00:01.000Z',
    target: { id: 'window:7', kind: 'window', name: 'Editor' },
    foregroundApplication: {
      id: 'application:42',
      name: 'Editor',
      bundleId: 'dev.editor',
      pid: 42,
      frontmost: true,
    },
    compatibility: {
      surfaceId: 'window:7:42',
      surfaceBounds: { x: 10, y: 20, width: 800, height: 600 },
      displayTopology: [{
        id: 'display:1',
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        displayScale: 2,
      }],
      foregroundApplicationId: 'application:42',
    },
    capture: {
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      displayScale: 2,
      pixelWidth: 1600,
      pixelHeight: 1200,
      screenshotCaptured: true,
    },
    elements: [],
    truncated: false,
    warnings: [],
  } as const
  const result = {
    version: COMPUTER_ACTION_VERSION,
    actionId: '11111111-1111-4111-8111-111111111111',
    previousSnapshotId: 'snapshot-1',
    completedAt: '2026-08-16T12:00:01.000Z',
    action: {
      kind: 'type',
      elementId: 'ax:0.1',
      textLength: 15,
      replace: true,
    },
    observation,
  } as const
  assert.deepEqual(parseComputerActionResult(result), result)
  assert.deepEqual(parseCapabilityResult('computer.act', result), result)
  assert.equal(parseComputerActionResult({
    ...result,
    action: { ...result.action, text: 'sensitive draft' },
  }), undefined)
})
