import {
  DESKTOP_PROTOCOL_VERSION,
  ConnectionRuntimeStatusParams,
  ConnectionSnapshot,
  ConnectionSummary,
  ComputerApplicationList,
  ComputerActParams,
  ComputerActionResult,
  ComputerObservation,
  ComputerPermissions,
  GitDiscoverParams,
  GitRepositoryIdentity,
  GitStatusParams,
  GitStatusSnapshot,
  McpTransportDescriptor,
  DesktopNotificationParams,
  DesktopSessionActivityParams,
  DesktopWorkspacePathParams,
  DesktopWorkspacePathResult,
} from '@dolphinminer/dsh-desktop-protocol'

import { DesktopCapabilityHandlers } from './desktop-capability-broker'

export interface DesktopNotificationAdapter {
  isSupported(): boolean
  show(params: DesktopNotificationParams): void
}

export interface DesktopCapabilityDependencies {
  isAppFocused(): boolean
  notifications: DesktopNotificationAdapter
  sessionActivity: {
    report(params: DesktopSessionActivityParams): boolean
  }
  workspaceFiles: {
    reveal(params: DesktopWorkspacePathParams, signal: AbortSignal): Promise<DesktopWorkspacePathResult>
    open(params: DesktopWorkspacePathParams, signal: AbortSignal): Promise<DesktopWorkspacePathResult>
  }
  connections: {
    snapshot(): ConnectionSnapshot
    resolveMcpTransport(connectionId: string, signal?: AbortSignal): Promise<{
      connection: ConnectionSummary
      transport: McpTransportDescriptor
    }>
    reportStatus(params: ConnectionRuntimeStatusParams): { accepted: boolean; revision: number }
  }
  computer?: {
    getPermissions(signal: AbortSignal): Promise<ComputerPermissions>
    listApplications(signal: AbortSignal): Promise<ComputerApplicationList>
    observe(sessionId: string, signal: AbortSignal): Promise<ComputerObservation>
    act(params: ComputerActParams, signal: AbortSignal): Promise<ComputerActionResult>
  }
  git: {
    discover(params: GitDiscoverParams, signal: AbortSignal): Promise<GitRepositoryIdentity>
    status(params: GitStatusParams, signal: AbortSignal): Promise<GitStatusSnapshot>
  }
}

function unsupportedComputer(): never {
  throw {
    code: 'UNSUPPORTED',
    message: 'Computer observation is unavailable on this platform or build.',
  }
}

export function createDesktopCapabilityHandlers(
  dependencies: DesktopCapabilityDependencies,
): DesktopCapabilityHandlers {
  return {
    'desktop.ping': params => ({
      nonce: params.nonce,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
    }),
    'desktop.notify': params => {
      if (dependencies.isAppFocused()) return { delivered: false, reason: 'foreground' }
      if (!dependencies.notifications.isSupported()) {
        return { delivered: false, reason: 'unsupported' }
      }
      dependencies.notifications.show(params)
      return { delivered: true }
    },
    'desktop.reportSessionActivity': params => ({
      accepted: dependencies.sessionActivity.report(params),
    }),
    'desktop.revealPath': (params, context) => dependencies.workspaceFiles.reveal(params, context.signal),
    'desktop.openPath': (params, context) => dependencies.workspaceFiles.open(params, context.signal),
    'computer.getPermissions': (_params, context) =>
      dependencies.computer?.getPermissions(context.signal) ?? unsupportedComputer(),
    'computer.listApps': (_params, context) =>
      dependencies.computer?.listApplications(context.signal) ?? unsupportedComputer(),
    'computer.observe': (params, context) =>
      dependencies.computer?.observe(params.sessionId, context.signal) ?? unsupportedComputer(),
    'computer.act': (params, context) =>
      dependencies.computer?.act(params, context.signal) ?? unsupportedComputer(),
    'git.discover': (params, context) => dependencies.git.discover(params, context.signal),
    'git.status': (params, context) => dependencies.git.status(params, context.signal),
    'connections.list': () => dependencies.connections.snapshot(),
    'connections.resolveMcpTransport': (params, context) =>
      dependencies.connections.resolveMcpTransport(params.connectionId, context.signal),
    'connections.reportStatus': params => dependencies.connections.reportStatus(params),
  }
}
