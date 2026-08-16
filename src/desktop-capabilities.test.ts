import assert from 'node:assert/strict'
import test from 'node:test'
import type { AutomationRunSummary, ComputerObservation } from '@dolphinminer/dsh-desktop-protocol'

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

const git = {
  discover: () => Promise.reject(new Error('not configured')),
  status: () => Promise.reject(new Error('not configured')),
  review: () => Promise.reject(new Error('not configured')),
  reportTurnBoundary: () => Promise.reject(new Error('not configured')),
}

const worktrees = {
  snapshot: () => ({ revision: 0, worktrees: [] }),
  provision: () => Promise.reject(new Error('not configured')),
  reportSessionBinding: () => Promise.reject(new Error('not configured')),
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
    git,
    worktrees,
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
    git,
    worktrees,
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
    git,
    worktrees,
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
    git,
    worktrees,
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

test('routes bounded computer observation and action capabilities', async () => {
  const calls: string[] = []
  const observation: ComputerObservation = {
    version: 2,
    snapshotId: 'snapshot-1',
    observedAt: '2026-08-16T12:00:00.000Z',
    target: { id: 'window:1', kind: 'window', name: 'Editor', pid: 42 },
    foregroundApplication: {
      id: 'application:42',
      name: 'Editor',
      pid: 42,
      frontmost: true,
    },
    compatibility: {
      surfaceId: 'window:1:42',
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      displayTopology: [{
        id: 'display:1',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        displayScale: 2,
      }],
      foregroundApplicationId: 'application:42',
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
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles,
    git,
    worktrees,
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
        return observation
      },
      act: async params => {
        calls.push(`act:${params.sessionId}:${params.action.kind}`)
        return {
          version: 1,
          actionId: params.actionId,
          previousSnapshotId: params.snapshotId,
          completedAt: '2026-08-16T12:00:01.000Z',
          action: {
            kind: 'click',
            target: { mode: 'element', elementId: 'ax:button' },
            button: 'left',
            clickCount: 1,
          },
          observation: { ...observation, snapshotId: 'snapshot-2' },
        }
      },
    },
  })
  const context = { requestId: 'computer-1', signal: new AbortController().signal }

  assert.equal((await handlers['computer.getPermissions']({}, context)).canObserve, true)
  assert.deepEqual((await handlers['computer.listApps']({}, context)).applications, [])
  assert.equal((await handlers['computer.observe']({ sessionId: 'session-1' }, context)).snapshotId, 'snapshot-1')
  assert.equal((await handlers['computer.act']({
    actionId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
    action: {
      kind: 'click',
      target: { mode: 'element', elementId: 'ax:button' },
      button: 'left',
      clickCount: 1,
    },
  }, context)).observation.snapshotId, 'snapshot-2')
  assert.deepEqual(calls, ['permissions', 'applications', 'observe:session-1', 'act:session-1:click'])
})

test('routes workspace-bound Git discovery, status, and review with caller cancellation', async () => {
  const calls: string[] = []
  const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles,
    connections,
    worktrees,
    git: {
      discover: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`discover:${params.sessionId}:${params.workspaceRoot}`)
        return repository
      },
      status: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`status:${params.repositoryRoot}`)
        return {
          repository,
          head: 'a'.repeat(40),
          branch: 'main',
          ahead: 0,
          behind: 0,
          clean: true,
          entries: [],
        }
      },
      review: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`review:${params.repositoryRoot}:${params.scope.kind}`)
        return {
          repository,
          scope: params.scope,
          head: 'a'.repeat(40),
          files: [],
          patch: '',
        }
      },
      reportTurnBoundary: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`turn:${params.boundary}:${String(params.turn)}`)
        return { accepted: true, state: params.boundary === 'start' ? 'started' : 'captured' }
      },
    },
  })
  const context = { requestId: 'git-1', signal: new AbortController().signal }
  const workspace = { sessionId: 'session-1', workspaceRoot: '/repo' }

  assert.deepEqual(await handlers['git.discover'](workspace, context), repository)
  assert.equal((await handlers['git.status']({ ...workspace, repositoryRoot: '/repo' }, context)).clean, true)
  assert.equal((await handlers['git.review']({
    ...workspace,
    repositoryRoot: '/repo',
    scope: { kind: 'unstaged' },
  }, context)).patch, '')
  assert.deepEqual(await handlers['git.reportTurnBoundary']({
    ...workspace,
    turn: 2,
    eventSeq: 9,
    eventTime: 1_787_000_000_000,
    boundary: 'start',
  }, context), { accepted: true, state: 'started' })
  assert.deepEqual(calls, [
    'discover:session-1:/repo',
    'status:/repo',
    'review:/repo:unstaged',
    'turn:start:2',
  ])
})

test('routes worktree provisioning as a caller-cancellable capability', async () => {
  const calls: string[] = []
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles,
    connections,
    git,
    worktrees: {
      snapshot: () => ({ revision: 4, worktrees: [] }),
      provision: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`${params.operationId}:${params.requestedBySessionId}:${params.baseRef}`)
        return {
          id: '11111111-1111-4111-8111-111111111111',
          repositoryRoot: '/repo',
          requestedBySessionId: params.requestedBySessionId,
          sessionState: 'pending',
          executionMode: 'worktree',
          worktreePath: '/worktrees/session-1',
          baseRef: params.baseRef,
          baseCommit: 'a'.repeat(40),
          branch: 'refs/heads/dsh/session-1',
          lifecycle: 'ready',
          createdAt: '2026-08-16T12:00:00.000Z',
          updatedAt: '2026-08-16T12:00:01.000Z',
        }
      },
      reportSessionBinding: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`bind:${params.sessionId}:${params.workspacePath}`)
        return { managed: false }
      },
    },
  })
  const params = {
    operationId: 'provision-1',
    requestedBySessionId: 'session-1',
    workspaceRoot: '/repo',
    baseRef: 'refs/heads/main',
  }

  const result = await handlers['worktrees.provision'](params, {
    requestId: 'worktree-1',
    signal: new AbortController().signal,
  })
  assert.equal(result.lifecycle, 'ready')
  assert.deepEqual(await handlers['worktrees.list']({}, {
    requestId: 'worktree-list-1',
    signal: new AbortController().signal,
  }), { revision: 4, worktrees: [] })
  assert.deepEqual(await handlers['desktop.reportSessionBinding']({
    sessionId: 'session-created',
    workspacePath: '/other',
  }, {
    requestId: 'worktree-binding-1',
    signal: new AbortController().signal,
  }), { managed: false })
  assert.deepEqual(calls, [
    'provision-1:session-1:refs/heads/main',
    'bind:session-created:/other',
  ])
})

test('routes Host automation claim and lifecycle evidence through Main', async () => {
  const hostInstanceId = '11111111-1111-4111-8111-111111111111'
  const runId = '22222222-2222-4222-8222-222222222222'
  const automationId = '33333333-3333-4333-8333-333333333333'
  const sessionId = '44444444-4444-4444-8444-444444444444'
  const queuedAt = '2026-08-16T12:00:00.000Z'
  const dispatchAt = '2026-08-16T12:00:01.000Z'
  const dispatching: AutomationRunSummary = {
    id: runId,
    automationId,
    payloadHash: 'a'.repeat(64),
    payload: {
      definitionRevision: 1,
      definitionName: 'Repository review',
      prompt: 'Review the repository.',
      projectPath: '/repo',
      repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
      trigger: { kind: 'once', at: queuedAt },
      execution: { mode: 'worktree', baseRef: 'refs/heads/main' },
      concurrencyPolicy: 'skip',
      skillIds: [],
      connectionIds: [],
      invocation: { kind: 'manual', requestedAt: queuedAt },
      sessionId,
    },
    phase: 'dispatching',
    cancellationRequested: false,
    createdAt: queuedAt,
    updatedAt: dispatchAt,
    events: [{ seq: 1, operationId: 'queue-run', at: queuedAt, type: 'queued' }, {
      seq: 2,
      operationId: 'dispatch-run',
      at: dispatchAt,
      type: 'dispatch',
      hostInstanceId,
      workspacePath: '/managed/run',
    }],
  }
  const calls: string[] = []
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles,
    connections,
    git,
    worktrees,
    automations: {
      claimNext: async (params, signal) => {
        assert.equal(signal.aborted, false)
        calls.push(`claim:${params.hostInstanceId}`)
        return { dispatch: { run: dispatching, workspacePath: '/managed/run' } }
      },
      inspectOwned: params => {
        calls.push(`inspect:${params.hostInstanceId}`)
        return dispatching
      },
      markRunning: params => {
        calls.push(`running:${params.runId}:${String(params.sessionEventSeq)}`)
        return { ...dispatching, phase: 'running' }
      },
      finish: params => {
        calls.push(`finish:${params.runId}:${params.outcome}`)
        return { ...dispatching, phase: params.outcome }
      },
    },
  })
  const context = { requestId: 'automation-1', signal: new AbortController().signal }

  assert.equal((await handlers['automations.claimNext']({ hostInstanceId }, context)).dispatch?.run.id, runId)
  assert.equal((await handlers['automations.inspectOwned']({ hostInstanceId }, context)).run?.id, runId)
  assert.equal((await handlers['automations.markRunning']({
    hostInstanceId,
    runId,
    sessionEventSeq: 3,
  }, context)).phase, 'running')
  assert.equal((await handlers['automations.finish']({
    hostInstanceId,
    runId,
    outcome: 'failed',
  }, context)).phase, 'failed')
  assert.deepEqual(calls, [
    `claim:${hostInstanceId}`,
    `inspect:${hostInstanceId}`,
    `running:${runId}:3`,
    `finish:${runId}:failed`,
  ])
})
