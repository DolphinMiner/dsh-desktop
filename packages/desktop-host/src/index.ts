import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import {
  ConnectionRuntimeStatusParams,
  DESKTOP_PROTOCOL_VERSION,
  DesktopCapabilityMethod,
  DesktopCapabilityParams,
  DesktopCapabilityResult,
  DesktopEventData,
  DesktopEventName,
  GitTurnBoundaryParams,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  DesktopCallOptions,
  DesktopCapabilityClient,
  processIpcTransport,
} from './bridge.js'
import { CordisMcpMountFactory } from './cordis-mcp.js'
import {
  AutomationDesktopClient,
  AutomationRunCoordinator,
  HarnessAutomationExecutor,
} from './automation-runner.js'
import { DesktopConnectionClient, McpConnectionSupervisor } from './mcp-supervisor.js'
import { GitTurnBoundaryCoordinator, reportTurnBoundaryAndActivity } from './git-turn-boundary.js'
import { WorktreeSessionGuard } from './worktree-guard.js'

export * from './bridge.js'
export * from './automation-runner.js'
export * from './mcp-supervisor.js'
export * from './git-turn-boundary.js'
export * from './worktree-guard.js'

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

export const inject = ['agentDefaultModel', 'agents', 'sessions', 'skills', 'tools']

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
  const automationClient: AutomationDesktopClient = {
    claimNext: async (hostInstanceId: string, signal: AbortSignal) =>
      (await bridge.call('automations.claimNext', { hostInstanceId }, { signal, timeoutMs: 70_000 })).dispatch,
    bindSession: (sessionId: string, workspacePath: string, signal: AbortSignal) =>
      bridge.call('desktop.reportSessionBinding', { sessionId, workspacePath }, { signal, timeoutMs: 40_000 }),
    markRunning: (hostInstanceId: string, runId: string, sessionEventSeq: number) =>
      bridge.call('automations.markRunning', { hostInstanceId, runId, sessionEventSeq }),
    finish: (hostInstanceId, runId, evidence) =>
      bridge.call('automations.finish', { hostInstanceId, runId, ...evidence }),
  }
  const automations = new AutomationRunCoordinator(
    randomUUID(),
    automationClient,
    new HarnessAutomationExecutor(ctx, supervisor),
    (message, error) => {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger('dsh-desktop').warn('%s %s', message, detail)
    },
  )
  const wakeAutomations = (): void => {
    try {
      void ctx.agents.withoutInitiator(() => automations.wake()).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger('dsh-desktop').warn('Durable automation wakeup failed: %s', message)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger('dsh-desktop').warn('Durable automation wakeup failed: %s', message)
    }
  }
  const worktreeGuard = new WorktreeSessionGuard()
  const turnBoundaries = new GitTurnBoundaryCoordinator(params => reportTurnBoundaryAndActivity(
    params,
    activity => bridge.call('desktop.reportSessionActivity', activity).then(() => undefined),
    boundary => bridge.call('git.reportTurnBoundary', boundary, { timeoutMs: 40_000 }).then(() => undefined),
  ), error => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger('dsh-desktop').warn('Git turn attribution unavailable: %s', message)
  })
  ctx.effect(() => () => supervisor.dispose(), 'dsh-desktop: MCP connection supervisor')
  ctx.effect(() => () => automations.dispose(), 'dsh-desktop: durable automation runner')

  bridge.on('connections.changed', () => {
    void supervisor.reconcile().catch(() => undefined)
  })
  bridge.on('worktrees.changed', event => {
    worktreeGuard.applyChange(event)
  })
  bridge.on('worktrees.snapshot', snapshot => {
    worktreeGuard.applySnapshot(snapshot)
  })
  ctx.on('tools/change', () => {
    void supervisor.refreshTools().catch(() => undefined)
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    await turnBoundaries.beforeTool(execution.agent)
    return next()
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

  worktreeGuard.applySnapshot(await bridge.call('worktrees.list', {}))

  ctx.on('session/created', session => {
    if (session.header.cwd === undefined) return
    void bridge.call('desktop.reportSessionActivity', {
      sessionId: session.id,
      eventSeq: session.seq,
      running: false,
      workspacePath: session.header.cwd,
    }).catch(() => undefined)
    const claim = worktreeGuard.claim(session.id, session.header.cwd)
    if (!claim.managed) return
    void bridge.call('desktop.reportSessionBinding', {
      sessionId: session.id,
      workspacePath: session.header.cwd,
    }).catch(() => undefined)
  })

  await supervisor.reconcile()
  bridge.on('automations.changed', wakeAutomations)
  wakeAutomations()

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      if (session.header.cwd === undefined) {
        void bridge.call('desktop.reportSessionActivity', {
          sessionId: session.id,
          eventSeq: event.seq,
          running: event.type === 'turn/start',
        }).catch(() => undefined)
      } else {
        const boundary: GitTurnBoundaryParams = event.type === 'turn/start'
          ? {
              sessionId: session.id,
              workspaceRoot: session.header.cwd,
              turn: event.data.turn,
              eventSeq: event.seq,
              eventTime: event.time,
              boundary: 'start',
            }
          : {
              sessionId: session.id,
              workspaceRoot: session.header.cwd,
              turn: event.data.turn,
              eventSeq: event.seq,
              eventTime: event.time,
              boundary: 'end',
              reason: event.data.reason.kind === 'completed' || event.data.reason.kind === 'aborted' ||
                event.data.reason.kind === 'blocked' || event.data.reason.kind === 'error' ||
                event.data.reason.kind === 'max-tokens' || event.data.reason.kind === 'interrupted'
                ? event.data.reason.kind
                : 'other',
            }
        void turnBoundaries.observe(boundary)
      }
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
