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
  resolveCredential: () => Promise.reject(new Error('not configured')),
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
