import {
  DESKTOP_PROTOCOL_VERSION,
  ConnectionRuntimeStatusParams,
  ConnectionSnapshot,
  ConnectionSummary,
  McpTransportDescriptor,
  DesktopNotificationParams,
  DesktopSessionActivityParams,
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
  connections: {
    snapshot(): ConnectionSnapshot
    resolveMcpTransport(connectionId: string, signal?: AbortSignal): Promise<{
      connection: ConnectionSummary
      transport: McpTransportDescriptor
    }>
    reportStatus(params: ConnectionRuntimeStatusParams): { accepted: boolean; revision: number }
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
    'connections.list': () => dependencies.connections.snapshot(),
    'connections.resolveMcpTransport': (params, context) =>
      dependencies.connections.resolveMcpTransport(params.connectionId, context.signal),
    'connections.reportStatus': params => dependencies.connections.reportStatus(params),
  }
}
