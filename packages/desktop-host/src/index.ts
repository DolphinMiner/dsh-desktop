import { Context, Service } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import type {} from '@deepseek-ai/dsh-session'
import {
  ConnectionRuntimeStatusParams,
  DESKTOP_PROTOCOL_VERSION,
  DesktopCapabilityMethod,
  DesktopCapabilityParams,
  DesktopCapabilityResult,
  DesktopEventData,
  DesktopEventName,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  DesktopCallOptions,
  DesktopCapabilityClient,
  processIpcTransport,
} from './bridge.js'
import { CordisMcpMountFactory } from './cordis-mcp.js'
import { DesktopConnectionClient, McpConnectionSupervisor } from './mcp-supervisor.js'

export * from './bridge.js'
export * from './mcp-supervisor.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopBridge: DesktopBridgeService
  }
}

export class DesktopBridgeService extends Service {
  private readonly client = new DesktopCapabilityClient(processIpcTransport())

  constructor(ctx: Context) {
    super(ctx, 'desktopBridge')
  }

  call<M extends DesktopCapabilityMethod>(
    method: M,
    params: DesktopCapabilityParams<M>,
    options?: DesktopCallOptions,
  ): Promise<DesktopCapabilityResult<M>> {
    return this.client.call(method, params, options)
  }

  on<E extends DesktopEventName>(
    event: E,
    listener: (data: DesktopEventData<E>) => void,
  ): () => void {
    return this.client.on(event, listener)
  }

  dispose(): void {
    this.client.dispose()
  }
}

export const inject = ['sessions', 'tools']

export async function apply(ctx: Context): Promise<void> {
  const bridge = new DesktopBridgeService(ctx)
  ctx.effect(() => () => bridge.dispose(), 'dsh-desktop: capability bridge')

  const connections: DesktopConnectionClient = {
    list: () => bridge.call('connections.list', {}),
    resolveMcpTransport: connectionId => bridge.call('connections.resolveMcpTransport', { connectionId }),
    reportStatus: (params: ConnectionRuntimeStatusParams) =>
      bridge.call('connections.reportStatus', params),
  }
  const supervisor = new McpConnectionSupervisor(connections, new CordisMcpMountFactory(ctx))
  ctx.effect(() => () => supervisor.dispose(), 'dsh-desktop: MCP connection supervisor')

  bridge.on('connections.changed', () => {
    void supervisor.reconcile().catch(() => undefined)
  })
  ctx.on('tools/change', () => {
    void supervisor.refreshTools().catch(() => undefined)
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    const downstream = await next()
    if (downstream.kind !== 'allow' || !supervisor.requiresApproval(execution.name)) return downstream
    return {
      kind: 'ask',
      reason: 'This Linear tool may change external data. Approve this operation once to continue.',
    }
  })

  void bridge.call('desktop.ping', {
    nonce: `host-${DESKTOP_PROTOCOL_VERSION}`,
  }).then(() => {
    ctx.logger('dsh-desktop').info('desktop capability bridge connected')
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger('dsh-desktop').warn('desktop capability bridge unavailable: %s', message)
  })

  await supervisor.reconcile()

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      void bridge.call('desktop.reportSessionActivity', {
        sessionId: session.id,
        eventSeq: event.seq,
        running: event.type === 'turn/start',
        ...(session.header.cwd === undefined ? {} : { workspacePath: session.header.cwd }),
      }).catch(() => undefined)
    }
    if (event.type !== 'turn/end') return
    const kind = event.data.reason.kind
    if (kind !== 'completed' && kind !== 'error') return
    const success = kind === 'completed'
    const workspace = session.header.cwd === undefined ? undefined : basename(session.header.cwd)
    void bridge.call('desktop.notify', {
      title: success ? 'DSH task completed' : 'DSH task failed',
      body: success
        ? `The agent finished${workspace === undefined ? '' : ` in ${workspace}`}.`
        : `The agent stopped with an error${workspace === undefined ? '' : ` in ${workspace}`}.`,
      sessionId: session.id,
      level: success ? 'success' : 'error',
    }).catch(() => undefined)
  })
}
