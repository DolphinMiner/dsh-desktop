export type HarnessPhase = 'starting' | 'ready' | 'error' | 'stopped'

export interface HarnessState {
  phase: HarnessPhase
  message: string
  url?: string
  logPath: string
}

export interface OAuthResultNotice {
  ok: boolean
  message: string
}

export interface DesktopBridge {
  getHarnessState(): Promise<HarnessState>
  retryHarness(): Promise<void>
  showHarnessLog(): Promise<void>
  pickProjectDirectory(): Promise<string | null>
  onHarnessState(listener: (state: HarnessState) => void): () => void
  onCommand(listener: (command: DesktopRendererCommand) => void): () => void
  connections: {
    list(): Promise<ConnectionSnapshot>
    connectApiKey(input: ConnectApiKeyInput): Promise<ConnectionSnapshot>
    disconnect(input: DisconnectConnectionInput): Promise<ConnectionSnapshot>
    beginOAuth(input: BeginOAuthInput): Promise<BeginOAuthResult>
    cancelOAuth(input: CancelOAuthInput): Promise<void>
    onChanged(listener: (snapshot: ConnectionSnapshot) => void): () => void
    onOAuthResult(listener: (result: OAuthResultNotice) => void): () => void
  }
}
import type {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectApiKeyInput,
  ConnectionSnapshot,
  DisconnectConnectionInput,
  DesktopRendererCommand,
} from '@dolphinminer/dsh-desktop-protocol'
