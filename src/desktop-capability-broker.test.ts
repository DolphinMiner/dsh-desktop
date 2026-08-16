import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCancel,
  createRequest,
  DESKTOP_PROTOCOL_VERSION,
  DesktopResponse,
} from '@dolphinminer/dsh-desktop-protocol'

import { DesktopCapabilityBroker } from './desktop-capability-broker'
import { createDesktopCapabilityHandlers } from './desktop-capabilities'

function testHandlers() {
  return createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: {
      isSupported: () => true,
      show: () => undefined,
    },
    sessionActivity: { report: () => true },
    workspaceFiles: {
      reveal: () => Promise.reject(new Error('not configured')),
      open: () => Promise.reject(new Error('not configured')),
    },
    git: {
      discover: () => Promise.reject(new Error('not configured')),
      status: () => Promise.reject(new Error('not configured')),
      review: () => Promise.reject(new Error('not configured')),
      reportTurnBoundary: () => Promise.reject(new Error('not configured')),
    },
    worktrees: {
      snapshot: () => ({ revision: 0, worktrees: [] }),
      provision: () => Promise.reject(new Error('not configured')),
      reportSessionBinding: () => Promise.resolve({ managed: false }),
    },
    connections: {
      snapshot: () => ({
        revision: 0,
        vault: { available: true, backend: 'test' },
        oauth: { linear: { available: false } },
        connections: [],
      }),
      resolveMcpTransport: () => Promise.reject(new Error('not configured')),
      reportStatus: () => ({ accepted: false, revision: 0 }),
    },
  })
}

test('dispatches allowlisted methods and validates parameters', async () => {
  const broker = new DesktopCapabilityBroker(testHandlers())
  const replies: DesktopResponse[] = []
  broker.receive(createRequest('ping-1', 'desktop.ping', { nonce: 'hello' }), value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(replies, [{
    channel: 'dsh-desktop',
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'response',
    id: 'ping-1',
    ok: true,
    result: { nonce: 'hello', protocolVersion: DESKTOP_PROTOCOL_VERSION },
  }])

  broker.receive({
    channel: 'dsh-desktop',
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'request',
    id: 'bad-1',
    method: 'desktop.notify',
    params: { title: '' },
  }, value => replies.push(value))
  assert.equal(replies[1]?.ok, false)
  if (replies[1]?.ok === false) assert.equal(replies[1].error.code, 'BAD_MESSAGE')
})

test('rejects unknown methods and replays one cached result for duplicate IDs', async () => {
  let calls = 0
  const handlers = testHandlers()
  handlers['desktop.ping'] = params => {
    calls += 1
    return { nonce: params.nonce, protocolVersion: DESKTOP_PROTOCOL_VERSION }
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  const request = createRequest('same-id', 'desktop.ping', { nonce: 'once' })
  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))
  broker.receive(request, value => replies.push(value))

  assert.equal(calls, 1)
  assert.equal(replies.length, 2)
  assert.deepEqual(replies[0], replies[1])

  broker.receive({
    channel: 'dsh-desktop',
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'request',
    id: 'unknown-1',
    method: 'desktop.nope',
    params: {},
  }, value => replies.push(value))
  assert.equal(replies[2]?.ok, false)
  if (replies[2]?.ok === false) assert.equal(replies[2].error.code, 'METHOD_NOT_FOUND')
})

test('never caches or replays computer action capability responses', async () => {
  let calls = 0
  const handlers = testHandlers()
  handlers['computer.act'] = () => {
    calls += 1
    throw {
      code: 'PERMISSION_DENIED',
      message: 'Computer actions are paused.',
    }
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  const request = createRequest('action-request', 'computer.act', {
    actionId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
    action: {
      kind: 'click',
      target: { mode: 'element', elementId: 'ax:button' },
      button: 'left',
      clickCount: 1,
    },
  })

  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))
  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls, 2)
  assert.equal(replies.length, 2)
  assert.ok(replies.every(reply => !reply.ok && reply.error.code === 'PERMISSION_DENIED'))
})

test('never retains browser screenshot bytes in the response cache', async () => {
  let calls = 0
  const handlers = testHandlers()
  handlers['browser.screenshot'] = params => {
    calls += 1
    return {
      snapshotId: params.snapshotId,
      tabId: 'tab-1',
      capturedAt: '2026-08-16T12:00:00.000Z',
      mediaType: 'image/jpeg',
      pixelWidth: 2,
      pixelHeight: 1,
      data: new Uint8Array([1, 2, 3]),
    }
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  const request = createRequest('browser-image', 'browser.screenshot', {
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
  })

  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))
  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls, 2)
  assert.equal(replies.length, 2)
  assert.ok(replies.every(reply => reply.ok && reply.result !== undefined))
})

test('never caches worktree provisioning responses at the capability broker', async () => {
  let calls = 0
  const handlers = testHandlers()
  handlers['worktrees.provision'] = () => {
    calls += 1
    throw {
      code: 'CONFLICT',
      message: 'The durable operation owner must decide whether recovery is safe.',
      ambiguous: true,
    }
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  const request = createRequest('worktree-request', 'worktrees.provision', {
    operationId: 'provision-1',
    requestedBySessionId: 'session-1',
    workspaceRoot: '/repo',
    baseRef: 'refs/heads/main',
  })

  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))
  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls, 2)
  assert.equal(replies.length, 2)
  assert.ok(replies.every(reply => !reply.ok && reply.error.ambiguous === true))
})

test('never caches Host automation claim responses at the capability broker', async () => {
  let calls = 0
  const handlers = testHandlers()
  handlers['automations.claimNext'] = () => {
    calls += 1
    throw {
      code: 'DESKTOP_UNAVAILABLE',
      message: 'The durable automation registry must resolve this claim.',
      ambiguous: true,
    }
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  const request = createRequest('automation-claim', 'automations.claimNext', {
    hostInstanceId: '11111111-1111-4111-8111-111111111111',
  })

  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))
  broker.receive(request, value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls, 2)
  assert.equal(replies.length, 2)
  assert.ok(replies.every(reply => !reply.ok && reply.error.ambiguous === true))
})

test('returns a structured failure when a capability handler throws synchronously', async () => {
  const handlers = testHandlers()
  handlers['desktop.ping'] = () => {
    throw new Error('synchronous failure')
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  broker.receive(createRequest('sync-failure', 'desktop.ping', { nonce: 'test' }), value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  const response = replies[0]
  assert.ok(response)
  assert.equal(response.ok, false)
  if (response.ok) return
  assert.equal(response.error.code, 'INTERNAL_ERROR')
  assert.equal(response.error.ambiguous, true)
})

test('preserves explicit ambiguous-result semantics from a capability owner', async () => {
  const handlers = testHandlers()
  handlers['desktop.ping'] = () => {
    throw {
      code: 'DESKTOP_UNAVAILABLE',
      message: 'The effect may have completed and must not be retried.',
      ambiguous: true,
    }
  }
  const broker = new DesktopCapabilityBroker(handlers)
  const replies: DesktopResponse[] = []
  broker.receive(createRequest('ambiguous-1', 'desktop.ping', { nonce: 'test' }), value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))

  const response = replies[0]
  assert.ok(response)
  assert.equal(response.ok, false)
  if (response.ok) return
  assert.equal(response.error.code, 'DESKTOP_UNAVAILABLE')
  assert.equal(response.error.ambiguous, true)
})

test('times out, cancels, and drops pending requests on disconnect', async () => {
  let aborted = false
  const handlers = testHandlers()
  handlers['desktop.ping'] = (_params, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
  const broker = new DesktopCapabilityBroker(handlers, { requestTimeoutMs: 5 })
  const replies: DesktopResponse[] = []
  broker.receive(createRequest('slow-1', 'desktop.ping', { nonce: 'slow' }), value => replies.push(value))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(aborted, true)
  assert.equal(replies[0]?.ok, false)
  if (replies[0]?.ok === false) assert.equal(replies[0].error.code, 'TIMEOUT')

  broker.receive(createRequest('cancel-1', 'desktop.ping', { nonce: 'cancel' }), value => replies.push(value))
  broker.receive(createCancel('cancel-1'), value => replies.push(value))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(replies[1]?.ok, false)
  if (replies[1]?.ok === false) assert.equal(replies[1].error.code, 'CANCELLED')

  broker.receive(createRequest('disconnect-1', 'desktop.ping', { nonce: 'disconnect' }), value => replies.push(value))
  broker.disconnect()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(replies.length, 2)
})
