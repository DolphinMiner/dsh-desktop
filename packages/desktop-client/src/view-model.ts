import type {
  AutomationRunPhase,
  AutomationState,
  ComputerActionHistorySummary,
  ComputerPermissionStatus,
  ConnectionAuthKind,
  ConnectionStatus,
} from '@dolphinminer/dsh-desktop-protocol'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

export function connectionStateDot(status: ConnectionStatus): StateDotState {
  if (status === 'connected') return 'done'
  if (status === 'connecting') return 'ongoing'
  if (status === 'error') return 'error'
  return 'warning'
}

export function connectionStatusLabel(status: ConnectionStatus): string {
  if (status === 'connected') return 'Connected'
  if (status === 'connecting') return 'Connecting'
  if (status === 'expired') return 'Authorization expired'
  if (status === 'error') return 'Connection error'
  return 'Disconnected'
}

export function canReconnect(status: ConnectionStatus): boolean {
  return status === 'disconnected' || status === 'expired' || status === 'error'
}

export type LinearConnectionAction = 'oauth' | 'oauth-unavailable' | 'api-key'

export function linearConnectionAction(
  authKind: ConnectionAuthKind | undefined,
  oauthAvailable: boolean,
): LinearConnectionAction {
  if (authKind === 'api-key') return 'api-key'
  return oauthAvailable ? 'oauth' : 'oauth-unavailable'
}

export type ComputerPermissionLabel = 'Allowed' | 'Not requested' | 'Unavailable' | 'Not allowed'

export function computerPermissionLabel(status: ComputerPermissionStatus): ComputerPermissionLabel {
  if (status === 'granted') return 'Allowed'
  if (status === 'not-determined') return 'Not requested'
  if (status === 'unavailable') return 'Unavailable'
  return 'Not allowed'
}

export function computerActionStatusLabel(status: ComputerActionHistorySummary['status']): string {
  if (status === 'intent') return 'Awaiting approval'
  if (status === 'approved') return 'Approved'
  if (status === 'dispatch') return 'Dispatched'
  if (status === 'succeeded') return 'Succeeded'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  return 'Result uncertain'
}

export function automationStateLabel(state: AutomationState): string {
  if (state === 'enabled') return 'Scheduled'
  if (state === 'paused') return 'Paused'
  return 'Completed'
}

export function automationStateDot(state: AutomationState): StateDotState {
  if (state === 'enabled') return 'ongoing'
  if (state === 'paused') return 'warning'
  return 'done'
}

export function automationRunPhaseLabel(phase: AutomationRunPhase): string {
  if (phase === 'queued') return 'Queued'
  if (phase === 'dispatching') return 'Preparing workspace'
  if (phase === 'running') return 'Running'
  if (phase === 'succeeded') return 'Finished'
  if (phase === 'failed') return 'Failed'
  if (phase === 'cancelled') return 'Cancelled'
  if (phase === 'interrupted') return 'Interrupted'
  return 'Outcome uncertain'
}

export function automationRunStateDot(phase: AutomationRunPhase): StateDotState {
  if (phase === 'queued' || phase === 'dispatching' || phase === 'running') return 'ongoing'
  if (phase === 'succeeded') return 'done'
  if (phase === 'cancelled' || phase === 'interrupted') return 'warning'
  return 'error'
}
