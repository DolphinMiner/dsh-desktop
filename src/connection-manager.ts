import {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectApiKeyInput,
  ConnectionCredential,
  ConnectionRuntimeStatusParams,
  ConnectionSnapshot,
  ConnectionStatus,
  ConnectionSummary,
  DisconnectConnectionInput,
  DesktopProtocolError,
} from '@dolphinminer/dsh-desktop-protocol'

import { ConnectionRegistry, StoredConnection } from './connection-registry'
import { CredentialVault, CredentialVaultError } from './credential-vault'
import { OAuthCompletion, OAuthConnectionProvider } from './oauth-types'

export class ConnectionManagerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'ConnectionManagerError'
  }
}

interface RuntimeConnectionState {
  status: ConnectionRuntimeStatusParams['status']
  statusMessage?: string
}

const MAX_RECEIPTS = 256

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new ConnectionManagerError('BAD_MESSAGE', `${name} is invalid.`)
  }
  return value
}

function summary(
  connection: StoredConnection,
  runtime: RuntimeConnectionState | undefined,
  vaultAvailable: boolean,
): ConnectionSummary {
  let status: ConnectionStatus = connection.enabled ? runtime?.status ?? 'connecting' : 'disconnected'
  let statusMessage = runtime?.statusMessage
  if (connection.enabled && !vaultAvailable) {
    status = 'error'
    statusMessage = 'Secure credential storage is unavailable.'
  }
  return {
    id: connection.id,
    provider: connection.provider,
    label: connection.label,
    ...(connection.account === undefined ? {} : { account: connection.account }),
    ...(connection.workspace === undefined ? {} : { workspace: connection.workspace }),
    authKind: connection.authKind,
    access: connection.access,
    scopes: [...connection.scopes],
    status,
    ...(statusMessage === undefined ? {} : { statusMessage }),
    enabledTools: [...connection.enabledTools],
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    ...(connection.lastConnectedAt === undefined ? {} : { lastConnectedAt: connection.lastConnectedAt }),
  }
}

export class ConnectionManager {
  private readonly runtime = new Map<string, RuntimeConnectionState>()
  private readonly listeners = new Set<(snapshot: ConnectionSnapshot) => void>()
  private readonly operations = new Map<string, Promise<ConnectionSnapshot>>()
  private readonly receipts = new Set<string>()
  private readonly connectionOperations = new Map<string, Promise<unknown>>()
  private effectiveRevision: number

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly vault: CredentialVault,
    private readonly oauth: OAuthConnectionProvider,
  ) {
    this.effectiveRevision = registry.revision
    if (vault.available) vault.prune(registry.activeSecretReferences())
  }

  snapshot(): ConnectionSnapshot {
    const connections = this.registry.list().map(connection =>
      summary(connection, this.runtime.get(connection.id), this.vault.available),
    )
    return {
      revision: this.effectiveRevision,
      vault: {
        available: this.vault.available,
        ...(this.vault.backend === undefined ? {} : { backend: this.vault.backend }),
      },
      oauth: { linear: { available: this.oauth.available } },
      connections,
    }
  }

  onChange(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  connectApiKey(input: ConnectApiKeyInput): Promise<ConnectionSnapshot> {
    return this.once(input.requestId, () => this.serializeConnection(
      input.connectionId ?? `connect:${input.requestId}`,
      async () => {
        if (input.provider !== 'linear' ||
          (input.access !== 'read-only' && input.access !== 'read-write')) {
          throw new ConnectionManagerError('BAD_MESSAGE', 'The connection provider or access mode is invalid.')
        }
        const apiKey = requiredString(input.apiKey, 'API key', 32_768)
        const label = input.label?.trim() || 'Linear workspace'
        if (label.length > 160) {
          throw new ConnectionManagerError('BAD_MESSAGE', 'The connection label is too long.')
        }
        if (input.connectionId !== undefined) requiredString(input.connectionId, 'Connection ID', 128)

        const credential: ConnectionCredential = {
          kind: 'api-key',
          accessToken: apiKey,
          scopes: input.access === 'read-only' ? ['read'] : ['read', 'write'],
        }
        let secretRef: string
        try {
          secretRef = this.vault.put(credential)
        } catch (error) {
          this.translateVaultError(error)
        }

        let previousSecretRef: string | undefined
        try {
          const result = this.registry.upsert({
            ...(input.connectionId === undefined ? {} : { id: input.connectionId }),
            provider: 'linear',
            label,
            authKind: 'api-key',
            access: input.access,
            scopes: [...credential.scopes],
            secretRef: secretRef!,
            operationId: input.requestId,
          })
          previousSecretRef = result.previousSecretRef
          this.runtime.set(result.connection.id, { status: 'connecting' })
        } catch (error) {
          this.deleteCredentialBestEffort(secretRef!)
          throw error
        }
        if (previousSecretRef !== undefined && previousSecretRef !== secretRef) {
          this.deleteCredentialBestEffort(previousSecretRef)
        }
        return this.changed()
      },
    ))
  }

  disconnect(input: DisconnectConnectionInput, signal?: AbortSignal): Promise<ConnectionSnapshot> {
    return this.once(input.requestId, () => this.serializeConnection(input.connectionId, async () => {
      if (signal?.aborted === true) throw new DOMException('The connection request was cancelled.', 'AbortError')
      const id = requiredString(input.connectionId, 'Connection ID', 128)
      const current = this.registry.get(id)
      if (current === undefined) throw new ConnectionManagerError('NOT_FOUND', 'The connection no longer exists.')
      if (current.secretRef !== undefined && current.authKind === 'oauth') {
        const credential = this.readCredential(current.secretRef)
        try {
          await this.oauth.revoke(credential, signal)
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          throw new ConnectionManagerError(
            'INTERNAL_ERROR',
            'The provider did not confirm token revocation; the connection was left enabled.',
          )
        }
      }
      const result = this.registry.disconnect(id)
      if (result?.previousSecretRef !== undefined) {
        this.deleteCredentialBestEffort(result.previousSecretRef)
      }
      this.runtime.delete(id)
      return this.changed()
    }))
  }

  async resolveCredential(connectionId: string, signal?: AbortSignal): Promise<{
    connection: ConnectionSummary
    credential: ConnectionCredential
  }> {
    const id = requiredString(connectionId, 'Connection ID', 128)
    return this.serializeConnection(id, async () => {
      if (signal?.aborted === true) throw new DOMException('The connection request was cancelled.', 'AbortError')
      const connection = this.registry.get(id)
      if (connection === undefined || !connection.enabled || connection.secretRef === undefined) {
        throw new ConnectionManagerError('NOT_FOUND', 'The connection is disconnected or missing.')
      }
      let credential = this.readCredential(connection.secretRef)
      if (credential.kind === 'oauth') {
        let refreshed: ConnectionCredential
        try {
          refreshed = await this.oauth.resolve(credential, signal)
        } catch (error) {
          const status = error instanceof ConnectionManagerError && error.code === 'AUTH_EXPIRED'
            ? 'expired'
            : 'error'
          this.registry.updateRuntime(
            connection.id,
            status,
            status === 'expired'
              ? 'Linear authorization expired. Reconnect the account.'
              : 'Linear authorization could not be refreshed.',
            [],
          )
          this.runtime.set(connection.id, {
            status,
            statusMessage: status === 'expired'
              ? 'Linear authorization expired. Reconnect the account.'
              : 'Linear authorization could not be refreshed.',
          })
          this.changed()
          throw error
        }
        if (refreshed !== credential) {
          this.vault.put(refreshed, connection.secretRef)
          credential = refreshed
        }
      }
      return {
        connection: summary(connection, this.runtime.get(connection.id), this.vault.available),
        credential,
      }
    })
  }

  reportStatus(params: ConnectionRuntimeStatusParams): { accepted: boolean; revision: number } {
    const connection = this.registry.updateRuntime(
      params.connectionId,
      params.status,
      params.statusMessage,
      params.enabledTools,
    )
    if (connection === undefined) return { accepted: false, revision: this.effectiveRevision }
    this.runtime.set(params.connectionId, {
      status: params.status,
      ...(params.statusMessage === undefined ? {} : { statusMessage: params.statusMessage }),
    })
    const snapshot = this.changed()
    return { accepted: true, revision: snapshot.revision }
  }

  hostDisconnected(): void {
    if (this.runtime.size === 0) return
    this.runtime.clear()
    this.changed()
  }

  beginOAuth(input: BeginOAuthInput, signal?: AbortSignal): Promise<BeginOAuthResult> {
    if (!this.oauth.available) {
      return Promise.reject(new ConnectionManagerError(
        'OAUTH_UNAVAILABLE',
        'Linear OAuth is not configured in this build. Connect with an API key instead.',
      ))
    }
    return this.oauth.begin(input, signal)
  }

  cancelOAuth(input: CancelOAuthInput): Promise<void> {
    return this.oauth.cancel(input)
  }

  completeOAuth(completion: OAuthCompletion): Promise<ConnectionSnapshot> {
    return this.once(`oauth:${completion.flowId}`, () => this.serializeConnection(
      completion.input.connectionId ?? `oauth:${completion.flowId}`,
      async () => {
        const scopes = [...completion.credential.scopes]
        const access = scopes.includes('write') ? 'read-write' : 'read-only'
        const label = completion.input.label?.trim() || completion.workspace || 'Linear workspace'
        const secretRef = this.vault.put(completion.credential)
        let previousSecretRef: string | undefined
        try {
          const result = this.registry.upsert({
            ...(completion.input.connectionId === undefined
              ? {}
              : { id: completion.input.connectionId }),
            provider: 'linear',
            label,
            ...(completion.account === undefined ? {} : { account: completion.account }),
            ...(completion.workspace === undefined ? {} : { workspace: completion.workspace }),
            authKind: 'oauth',
            access,
            scopes,
            secretRef,
            operationId: completion.flowId,
          })
          previousSecretRef = result.previousSecretRef
          this.runtime.set(result.connection.id, { status: 'connecting' })
        } catch (error) {
          this.deleteCredentialBestEffort(secretRef)
          throw error
        }
        if (previousSecretRef !== undefined && previousSecretRef !== secretRef) {
          this.deleteCredentialBestEffort(previousSecretRef)
        }
        return this.changed()
      },
    ))
  }

  private readCredential(secretRef: string): ConnectionCredential {
    let credential: ConnectionCredential | undefined
    try {
      credential = this.vault.get(secretRef)
    } catch (error) {
      this.translateVaultError(error)
    }
    if (credential === undefined) {
      throw new ConnectionManagerError('NOT_FOUND', 'The encrypted credential is missing.')
    }
    return credential
  }

  private once(requestIdValue: string, operation: () => Promise<ConnectionSnapshot>): Promise<ConnectionSnapshot> {
    const requestId = requiredString(requestIdValue, 'Request ID', 128)
    if (this.receipts.has(requestId)) return Promise.resolve(this.snapshot())
    const existing = this.operations.get(requestId)
    if (existing !== undefined) return existing
    const pending = operation().then(snapshot => {
      this.receipts.add(requestId)
      while (this.receipts.size > MAX_RECEIPTS) {
        const oldest = this.receipts.values().next().value as string | undefined
        if (oldest === undefined) break
        this.receipts.delete(oldest)
      }
      return snapshot
    }).finally(() => this.operations.delete(requestId))
    this.operations.set(requestId, pending)
    return pending
  }

  private serializeConnection<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.connectionOperations.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(operation)
    this.connectionOperations.set(key, pending)
    return pending.finally(() => {
      if (this.connectionOperations.get(key) === pending) this.connectionOperations.delete(key)
    })
  }

  private changed(): ConnectionSnapshot {
    this.effectiveRevision = Math.max(this.effectiveRevision + 1, this.registry.revision)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  private translateVaultError(error: unknown): never {
    if (error instanceof CredentialVaultError) {
      throw new ConnectionManagerError(error.code, error.message)
    }
    throw error
  }

  private deleteCredentialBestEffort(reference: string): void {
    try {
      this.vault.delete(reference)
    } catch {
      // The registry no longer references this encrypted value; startup pruning retries cleanup.
    }
  }
}
