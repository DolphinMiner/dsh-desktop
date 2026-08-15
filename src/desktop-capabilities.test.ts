import assert from 'node:assert/strict'
import test from 'node:test'

import { createDesktopCapabilityHandlers } from './desktop-capabilities'

const connections = {
  snapshot: () => ({
    revision: 0,
    vault: { available: true },
    oauth: { linear: { available: false } },
    connections: [],
  }),
  resolveMcpTransport: () => Promise.reject(new Error('not configured')),
  reportStatus: () => ({ accepted: false, revision: 0 }),
}

test('suppresses native notifications while the app is focused', async () => {
  let shown = 0
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => true,
    notifications: {
      isSupported: () => true,
      show: () => { shown += 1 },
    },
    sessionActivity: { report: () => true },
    connections,
  })

  assert.deepEqual(
    await handlers['desktop.notify']({ title: 'Done' }, {
      requestId: 'notify-1',
      signal: new AbortController().signal,
    }),
    { delivered: false, reason: 'foreground' },
  )
  assert.equal(shown, 0)
})

test('reports unsupported notifications and dispatches supported notifications once', async () => {
  let supported = false
  const shown: string[] = []
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: {
      isSupported: () => supported,
      show: params => shown.push(params.title),
    },
    sessionActivity: { report: () => true },
    connections,
  })
  const context = { requestId: 'notify-2', signal: new AbortController().signal }

  assert.deepEqual(
    await handlers['desktop.notify']({ title: 'First' }, context),
    { delivered: false, reason: 'unsupported' },
  )
  supported = true
  assert.deepEqual(
    await handlers['desktop.notify']({ title: 'Second' }, context),
    { delivered: true },
  )
  assert.deepEqual(shown, ['Second'])
})

test('projects session activity through the desktop-owned tracker', async () => {
  const reported: string[] = []
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: {
      report: params => {
        reported.push(`${params.sessionId}:${String(params.running)}`)
        return true
      },
    },
    connections,
  })

  assert.deepEqual(await handlers['desktop.reportSessionActivity']({
    sessionId: 'session-1',
    eventSeq: 4,
    running: true,
  }, {
    requestId: 'activity-1',
    signal: new AbortController().signal,
  }), { accepted: true })
  assert.deepEqual(reported, ['session-1:true'])
})
