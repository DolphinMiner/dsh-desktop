import {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectionCredential,
} from '@dolphinminer/dsh-desktop-protocol'

import { ConnectionManagerError, OAuthConnectionProvider } from './connection-manager'

export class UnavailableOAuthProvider implements OAuthConnectionProvider {
  readonly available = false

  begin(_input: BeginOAuthInput, _signal?: AbortSignal): Promise<BeginOAuthResult> {
    return Promise.reject(new ConnectionManagerError(
      'OAUTH_UNAVAILABLE',
      'Linear OAuth is not configured in this build.',
    ))
  }

  cancel(_input: CancelOAuthInput): Promise<void> {
    return Promise.resolve()
  }

  resolve(credential: ConnectionCredential, _signal?: AbortSignal): Promise<ConnectionCredential> {
    return Promise.resolve(credential)
  }

  revoke(_credential: ConnectionCredential, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve()
  }
}
