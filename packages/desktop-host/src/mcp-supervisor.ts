import {
  ConnectionRuntimeStatusParams,
  ConnectionSnapshot,
  ConnectionSummary,
  isLikelyReadOnlyMcpTool,
  McpTransportDescriptor,
} from '@dolphinminer/dsh-desktop-protocol'

export interface DesktopConnectionClient {
  list(): Promise<ConnectionSnapshot>
  resolveMcpTransport(connectionId: string): Promise<{
    connection: ConnectionSummary
    transport: McpTransportDescriptor
  }>
  reportStatus(params: ConnectionRuntimeStatusParams): Promise<{ accepted: boolean; revision: number }>
}

export interface McpMountHandle {
  readonly serverName: string
  toolNames(): string[]
  dispose(): Promise<void>
}

export interface McpMountFactory {
  mount(transport: McpTransportDescriptor): Promise<McpMountHandle>
}

interface MountedConnection {
  fingerprint: string
  access: ConnectionSummary['access']
  handle: McpMountHandle
  reportKey?: string
}

export interface AutomationConnectionScope {
  allowedPrefixes: string[]
  deniedToolNames: string[]
}

function connectionFingerprint(connection: ConnectionSummary): string {
  return JSON.stringify({
    id: connection.id,
    provider: connection.provider,
    authKind: connection.authKind,
    access: connection.access,
    scopes: connection.scopes,
    updatedAt: connection.updatedAt,
  })
}

function statusKey(params: ConnectionRuntimeStatusParams): string {
  return JSON.stringify(params)
}

export class McpConnectionSupervisor {
  private readonly mounted = new Map<string, MountedConnection>()
  private readonly failed = new Map<string, string>()
  private requested = false
  private draining?: Promise<void>
  private disposed = false

  constructor(
    private readonly connections: DesktopConnectionClient,
    private readonly mounts: McpMountFactory,
  ) {}

  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.requested = true
    if (this.draining === undefined) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined
        if (this.requested && !this.disposed) void this.reconcile()
      })
    }
    return this.draining
  }

  async refreshTools(): Promise<void> {
    for (const [connectionId, mounted] of this.mounted) {
      const tools = mounted.handle.toolNames().sort()
      await this.report(connectionId, mounted, {
        connectionId,
        status: tools.length === 0 ? 'connecting' : 'connected',
        ...(tools.length === 0 ? { statusMessage: 'Reconnecting to the MCP server.' } : {}),
        enabledTools: tools,
      })
    }
  }

  requiresApproval(toolName: string): boolean {
    for (const mounted of this.mounted.values()) {
      const prefix = `mcp__${mounted.handle.serverName}__`
      if (!toolName.startsWith(prefix)) continue
      if (mounted.access === 'read-only') return false
      return !isLikelyReadOnlyMcpTool(toolName.slice(prefix.length))
    }
    return false
  }

  automationScope(connectionIds: readonly string[]): AutomationConnectionScope {
    const selected = new Set(connectionIds)
    const missing = connectionIds.filter(connectionId => !this.mounted.has(connectionId))
    if (missing.length > 0) {
      throw new Error(`Selected Connections are unavailable: ${missing.join(', ')}`)
    }
    const allowedPrefixes: string[] = []
    const deniedToolNames: string[] = []
    for (const [connectionId, mounted] of this.mounted) {
      const prefix = `mcp__${mounted.handle.serverName}__`
      const tools = mounted.handle.toolNames().filter(name => name.startsWith(prefix))
      if (selected.has(connectionId)) {
        if (tools.length === 0) throw new Error(`Selected Connection "${connectionId}" has no available tools.`)
        allowedPrefixes.push(prefix)
      } else {
        deniedToolNames.push(...tools)
      }
    }
    return {
      allowedPrefixes: allowedPrefixes.sort(),
      deniedToolNames: [...new Set(deniedToolNames)].sort(),
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.requested = false
    await this.draining
    const mounted = [...this.mounted.values()]
    this.mounted.clear()
    await Promise.allSettled(mounted.map(item => item.handle.dispose()))
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false
      await this.reconcileOnce()
    }
  }

  private async reconcileOnce(): Promise<void> {
    const snapshot = await this.connections.list()
    const desired = new Map(snapshot.connections
      .filter(connection => connection.status !== 'disconnected' && connection.status !== 'expired')
      .map(connection => [connection.id, connection]))
    for (const connectionId of this.failed.keys()) {
      if (!desired.has(connectionId)) this.failed.delete(connectionId)
    }

    for (const [connectionId, mounted] of [...this.mounted]) {
      const connection = desired.get(connectionId)
      if (connection !== undefined && mounted.fingerprint === connectionFingerprint(connection)) continue
      this.mounted.delete(connectionId)
      await mounted.handle.dispose()
    }

    for (const connection of desired.values()) {
      if (this.mounted.has(connection.id)) continue
      const fingerprint = connectionFingerprint(connection)
      if (this.failed.get(connection.id) === fingerprint) continue
      try {
        await this.connections.reportStatus({ connectionId: connection.id, status: 'connecting' })
        const resolved = await this.connections.resolveMcpTransport(connection.id)
        const handle = await this.mounts.mount(resolved.transport)
        const mounted: MountedConnection = { fingerprint, access: connection.access, handle }
        this.mounted.set(connection.id, mounted)
        this.failed.delete(connection.id)
        await this.report(connection.id, mounted, {
          connectionId: connection.id,
          status: 'connected',
          enabledTools: handle.toolNames().sort(),
        })
      } catch {
        this.failed.set(connection.id, fingerprint)
        await this.connections.reportStatus({
          connectionId: connection.id,
          status: 'error',
          statusMessage: 'Could not connect to the MCP server. Reconnect to try again.',
          enabledTools: [],
        }).catch(() => undefined)
      }
    }
  }

  private async report(
    connectionId: string,
    mounted: MountedConnection,
    params: ConnectionRuntimeStatusParams,
  ): Promise<void> {
    const key = statusKey(params)
    if (mounted.reportKey === key) return
    mounted.reportKey = key
    try {
      await this.connections.reportStatus(params)
    } catch {
      mounted.reportKey = undefined
    }
  }
}
