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

const workspaceFiles = {
  reveal: () => Promise.reject(new Error('not configured')),
  open: () => Promise.reject(new Error('not configured')),
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
    workspaceFiles,
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
    workspaceFiles,
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
    workspaceFiles,
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

test('dispatches workspace file capabilities with caller cancellation', async () => {
  const operations: string[] = []
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles: {
      reveal: async (params, signal) => {
        assert.equal(signal.aborted, false)
        operations.push(`reveal:${params.path}`)
        return { opened: true, path: `/repo/${params.path}` }
      },
      open: async (params, signal) => {
        assert.equal(signal.aborted, false)
        operations.push(`open:${params.path}`)
        return { opened: true, path: `/repo/${params.path}` }
      },
    },
    connections,
  })
  const context = { requestId: 'path-1', signal: new AbortController().signal }
  const params = { sessionId: 'session-1', workspaceRoot: '/repo', path: 'README.md' }

  assert.deepEqual(await handlers['desktop.revealPath'](params, context), {
    opened: true,
    path: '/repo/README.md',
  })
  assert.deepEqual(await handlers['desktop.openPath'](params, context), {
    opened: true,
    path: '/repo/README.md',
  })
  assert.deepEqual(operations, ['reveal:README.md', 'open:README.md'])
})

test('routes only the bounded read-only computer capabilities', async () => {
  const calls: string[] = []
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles,
    connections,
    computer: {
      getPermissions: async signal => {
        assert.equal(signal.aborted, false)
        calls.push('permissions')
        return {
          supported: true,
          screenRecording: 'granted',
          accessibility: 'denied',
          canObserve: true,
          canAct: false,
        }
      },
      listApplications: async () => {
        calls.push('applications')
        return {
          permissions: {
            supported: true,
            screenRecording: 'granted',
            accessibility: 'denied',
            canObserve: true,
            canAct: false,
          },
          applications: [],
        }
      },
      observe: async sessionId => {
        calls.push(`observe:${sessionId}`)
        return {
          version: 2,
          snapshotId: 'snapshot-1',
          observedAt: '2026-08-16T12:00:00.000Z',
          target: { id: 'display:1', kind: 'display', name: 'Main Display' },
          compatibility: {
            surfaceId: 'display:1',
            surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
            displayTopology: [{
              id: 'display:1',
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              displayScale: 2,
            }],
          },
          capture: {
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            displayScale: 2,
            pixelWidth: 1600,
            pixelHeight: 1200,
            screenshotCaptured: true,
          },
          elements: [],
          truncated: false,
          warnings: [],
        }
      },
    },
  })
  const context = { requestId: 'computer-1', signal: new AbortController().signal }

  assert.equal((await handlers['computer.getPermissions']({}, context)).canObserve, true)
  assert.deepEqual((await handlers['computer.listApps']({}, context)).applications, [])
  assert.equal((await handlers['computer.observe']({ sessionId: 'session-1' }, context)).snapshotId, 'snapshot-1')
  assert.deepEqual(calls, ['permissions', 'applications', 'observe:session-1'])
})
