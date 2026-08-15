import type { ConnectionStatus } from '@dolphinminer/dsh-desktop-protocol'
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
