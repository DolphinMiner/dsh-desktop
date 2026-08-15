import type {
  ComputerActionHistorySummary,
  ComputerPermissionStatus,
  ComputerTargetKind,
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

export function computerPermissionLabel(status: ComputerPermissionStatus): string {
  if (status === 'granted') return 'Allowed'
  if (status === 'not-determined') return 'Not requested'
  if (status === 'unavailable') return 'Unavailable'
  return 'Not allowed'
}

export function computerTargetGroupLabel(kind: ComputerTargetKind): string {
  if (kind === 'application') return 'Applications'
  if (kind === 'window') return 'Windows'
  return 'Displays'
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

export function computerActionStateDot(status: ComputerActionHistorySummary['status']): StateDotState {
  if (status === 'succeeded') return 'done'
  if (status === 'intent' || status === 'approved' || status === 'dispatch') return 'ongoing'
  if (status === 'cancelled') return 'warning'
  return 'error'
}
