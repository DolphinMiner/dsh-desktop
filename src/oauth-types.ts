import {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectionCredential,
} from '@dolphinminer/dsh-desktop-protocol'

export interface OAuthCompletion {
  flowId: string
  input: BeginOAuthInput
  credential: ConnectionCredential
  account?: string
  workspace?: string
}

export interface OAuthConnectionProvider {
  readonly available: boolean
  begin(input: BeginOAuthInput, signal?: AbortSignal): Promise<BeginOAuthResult>
  cancel(input: CancelOAuthInput): Promise<void>
  resolve(credential: ConnectionCredential, signal?: AbortSignal): Promise<ConnectionCredential>
  revoke(credential: ConnectionCredential, signal?: AbortSignal): Promise<void>
  setCompletionHandler(handler: (completion: OAuthCompletion) => Promise<void>): void
  handleCallback(url: string): Promise<void>
}
