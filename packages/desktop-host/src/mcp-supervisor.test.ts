import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConnectionRuntimeStatusParams,
  ConnectionSnapshot,
  ConnectionSummary,
  McpTransportDescriptor,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  DesktopConnectionClient,
  McpConnectionSupervisor,
  McpMountFactory,
  McpMountHandle,
} from './mcp-supervisor.js'

function summary(
  id: string,
  access: ConnectionSummary['access'] = 'read-only',
  updatedAt = '2026-08-15T00:00:00.000Z',
): ConnectionSummary {
  return {
    id,
    provider: 'linear',
    label: id,
    authKind: 'api-key',
    access,
    scopes: access === 'read-only' ? ['read'] : ['read', 'write'],
    status: 'connecting',
    enabledTools: [],
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt,
  }
}

function snapshot(connections: ConnectionSummary[], revision = 1): ConnectionSnapshot {
  return {
    revision,
    vault: { available: true, backend: 'test' },
    oauth: { linear: { available: false } },
    connections,
  }
}

class FakeConnections implements DesktopConnectionClient {
  current = snapshot([])
  readonly reports: ConnectionRuntimeStatusParams[] = []

  list(): Promise<ConnectionSnapshot> {
    return Promise.resolve(this.current)
  }

  resolveMcpTransport(connectionId: string): Promise<{
    connection: ConnectionSummary
    transport: McpTransportDescriptor
  }> {
    const connection = this.current.connections.find(item => item.id === connectionId)
    if (connection === undefined) return Promise.reject(new Error('missing'))
    return Promise.resolve({
      connection,
      transport: {
        transport: 'streamable-http',
        serverName: `linear_${connectionId}`,
        url: `http://127.0.0.1:4000/${connectionId}`,
      },
    })
  }

  reportStatus(params: ConnectionRuntimeStatusParams): Promise<{ accepted: boolean; revision: number }> {
    this.reports.push(params)
    return Promise.resolve({ accepted: true, revision: this.current.revision })
  }
}

class FakeHandle implements McpMountHandle {
  tools: string[]
  disposed = 0

  constructor(readonly serverName: string) {
    this.tools = [`mcp__${serverName}__list_issues`, `mcp__${serverName}__create_issue`]
  }

  toolNames(): string[] { return [...this.tools] }
  dispose(): Promise<void> {
    this.disposed += 1
    return Promise.resolve()
  }
}

class FakeMounts implements McpMountFactory {
  readonly handles = new Map<string, FakeHandle>()
  failures = new Set<string>()
  calls = 0

  mount(transport: McpTransportDescriptor): Promise<McpMountHandle> {
    this.calls += 1
    if (this.failures.has(transport.serverName)) return Promise.reject(new Error('offline'))
    const handle = new FakeHandle(transport.serverName)
    this.handles.set(transport.serverName, handle)
    return Promise.resolve(handle)
  }
}

test('mounts each workspace, reports tools, and disposes removed connections', async () => {
  const connections = new FakeConnections()
  connections.current = snapshot([summary('acme'), summary('labs', 'read-write')])
  const mounts = new FakeMounts()
  const supervisor = new McpConnectionSupervisor(connections, mounts)

  await supervisor.reconcile()
  assert.equal(mounts.calls, 2)
  assert.equal(connections.reports.filter(report => report.status === 'connected').length, 2)
  assert.equal(supervisor.requiresApproval('mcp__linear_labs__list_issues'), false)
  assert.equal(supervisor.requiresApproval('mcp__linear_labs__create_issue'), true)
  assert.equal(supervisor.requiresApproval('mcp__linear_acme__create_issue'), false)

  const acme = mounts.handles.get('linear_acme')
  connections.current = snapshot([summary('labs', 'read-write')], 2)
  await supervisor.reconcile()
  assert.equal(acme?.disposed, 1)
  await supervisor.dispose()
})

test('does not spin on a failed mount and retries after configuration changes', async () => {
  const connections = new FakeConnections()
  connections.current = snapshot([summary('acme')])
  const mounts = new FakeMounts()
  mounts.failures.add('linear_acme')
  const supervisor = new McpConnectionSupervisor(connections, mounts)

  await supervisor.reconcile()
  await supervisor.reconcile()
  assert.equal(mounts.calls, 1)
  assert.equal(connections.reports.at(-1)?.status, 'error')

  connections.current = snapshot([summary('acme', 'read-only', '2026-08-15T01:00:00.000Z')], 2)
  mounts.failures.clear()
  await supervisor.reconcile()
  assert.equal(mounts.calls, 2)
  assert.equal(connections.reports.at(-1)?.status, 'connected')
  await supervisor.dispose()
})

test('projects reconnecting state when a mounted server temporarily has no tools', async () => {
  const connections = new FakeConnections()
  connections.current = snapshot([summary('acme')])
  const mounts = new FakeMounts()
  const supervisor = new McpConnectionSupervisor(connections, mounts)
  await supervisor.reconcile()

  const handle = mounts.handles.get('linear_acme')
  if (handle === undefined) throw new Error('missing handle')
  handle.tools = []
  await supervisor.refreshTools()
  assert.equal(connections.reports.at(-1)?.status, 'connecting')
  assert.equal(connections.reports.at(-1)?.statusMessage, 'Reconnecting to the MCP server.')
  await supervisor.dispose()
})

test('builds a fail-closed per-automation MCP allowlist', async () => {
  const connections = new FakeConnections()
  connections.current = snapshot([summary('acme'), summary('labs')])
  const mounts = new FakeMounts()
  const supervisor = new McpConnectionSupervisor(connections, mounts)
  await supervisor.reconcile()

  assert.deepEqual(supervisor.automationScope(['labs']), {
    allowedPrefixes: ['mcp__linear_labs__'],
    deniedToolNames: [
      'mcp__linear_acme__create_issue',
      'mcp__linear_acme__list_issues',
    ],
  })
  assert.throws(() => supervisor.automationScope(['missing']), /unavailable/)
  mounts.handles.get('linear_labs')!.tools = []
  assert.throws(() => supervisor.automationScope(['labs']), /no available tools/)
  await supervisor.dispose()
})
