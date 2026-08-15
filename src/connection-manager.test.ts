import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectionCredential,
} from '@dolphinminer/dsh-desktop-protocol'

import { ConnectionManager } from './connection-manager'
import { ConnectionRegistry } from './connection-registry'
import { CredentialEncryptionAdapter, CredentialVault } from './credential-vault'
import { OAuthCompletion, OAuthConnectionProvider } from './oauth-types'

class TestEncryption implements CredentialEncryptionAdapter {
  isAvailable(): boolean { return true }
  backend(): string { return 'test-keychain' }
  encrypt(value: string): Buffer {
    return Buffer.from([...Buffer.from(value, 'utf8')].map(byte => byte ^ 0x5a))
  }
  decrypt(value: Buffer): string {
    return Buffer.from([...value].map(byte => byte ^ 0x5a)).toString('utf8')
  }
}

class TestOAuth implements OAuthConnectionProvider {
  constructor(readonly available = false) {}
  begin(_input: BeginOAuthInput): Promise<BeginOAuthResult> { throw new Error('not configured') }
  cancel(_input: CancelOAuthInput): Promise<void> { return Promise.resolve() }
  resolve(value: ConnectionCredential): Promise<ConnectionCredential> { return Promise.resolve(value) }
  revoke(_value: ConnectionCredential): Promise<void> { return Promise.resolve() }
  setCompletionHandler(_handler: (completion: OAuthCompletion) => Promise<void>): void {}
  handleCallback(_url: string): Promise<void> { return Promise.reject(new Error('not configured')) }
}

function manager(root: string, oauth: OAuthConnectionProvider = new TestOAuth()): ConnectionManager {
  return new ConnectionManager(
    new ConnectionRegistry(join(root, 'connections.v1.json')),
    new CredentialVault(join(root, 'credentials.v1.json'), new TestEncryption()),
    oauth,
  )
}

class RotatingOAuth extends TestOAuth {
  refreshCalls = 0
  revokedAccessToken?: string
  private releaseRefresh?: () => void
  private markRefreshStarted: () => void = () => undefined
  private readonly refreshStarted = new Promise<void>(resolve => {
    this.markRefreshStarted = resolve
  })

  constructor(private readonly pauseRefresh = false) {
    super(true)
  }

  waitForRefresh(): Promise<void> {
    return this.refreshStarted
  }

  continueRefresh(): void {
    this.releaseRefresh?.()
  }

  override async resolve(value: ConnectionCredential): Promise<ConnectionCredential> {
    if (value.accessToken !== 'old-access') return value
    this.refreshCalls += 1
    this.markRefreshStarted()
    if (this.pauseRefresh) await new Promise<void>(resolve => { this.releaseRefresh = resolve })
    return {
      kind: 'oauth',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['read'],
    }
  }

  override revoke(value: ConnectionCredential): Promise<void> {
    this.revokedAccessToken = value.accessToken
    return Promise.resolve()
  }
}

function expiredOAuthCompletion(flowId: string): OAuthCompletion {
  return {
    flowId,
    input: {
      requestId: `${flowId}-request`,
      provider: 'linear',
      access: 'read-only',
    },
    credential: {
      kind: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2020-01-01T00:00:00.000Z',
      scopes: ['read'],
    },
  }
}

test('persists multiple workspaces, deduplicates submissions, and restores without exposing tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-test-'))
  try {
    const connections = manager(root)
    const firstRequest = {
      requestId: 'connect-acme',
      provider: 'linear' as const,
      apiKey: 'lin_api_acme_secret',
      access: 'read-only' as const,
      label: 'Acme',
    }
    const [first, duplicate] = await Promise.all([
      connections.connectApiKey(firstRequest),
      connections.connectApiKey(firstRequest),
    ])
    assert.equal(first.connections.length, 1)
    assert.deepEqual(first, duplicate)

    const second = await connections.connectApiKey({
      requestId: 'connect-labs',
      provider: 'linear',
      apiKey: 'lin_api_labs_secret',
      access: 'read-write',
      label: 'Labs',
    })
    assert.deepEqual(second.connections.map(item => item.label), ['Acme', 'Labs'])
    assert.equal(second.connections[0].status, 'connecting')

    const firstId = second.connections[0].id
    const resolved = await connections.resolveCredential(firstId)
    assert.equal(resolved.credential.accessToken, 'lin_api_acme_secret')
    const report = connections.reportStatus({
      connectionId: firstId,
      status: 'connected',
      enabledTools: ['mcp__linear_acme__list_issues'],
    })
    assert.equal(report.accepted, true)
    assert.equal(connections.snapshot().connections[0].status, 'connected')

    const registrySource = await readFile(join(root, 'connections.v1.json'), 'utf8')
    const vaultSource = await readFile(join(root, 'credentials.v1.json'), 'utf8')
    assert.equal(registrySource.includes('lin_api_'), false)
    assert.equal(vaultSource.includes('lin_api_'), false)

    const restartedManager = manager(root)
    const restarted = restartedManager.snapshot()
    assert.equal(restarted.connections.length, 2)
    assert.equal(restarted.connections[0].status, 'connecting')
    assert.deepEqual(restarted.connections[0].enabledTools, ['mcp__linear_acme__list_issues'])
    const coldDuplicate = await restartedManager.connectApiKey(firstRequest)
    assert.equal(coldDuplicate.connections.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commits an OAuth handoff idempotently across a cold restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-commit-test-'))
  const completion = {
    flowId: 'oauth-flow-1',
    input: {
      requestId: 'oauth-request-1',
      provider: 'linear' as const,
      access: 'read-write' as const,
    },
    credential: {
      kind: 'oauth' as const,
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAt: '2026-08-17T00:00:00.000Z',
      scopes: ['read', 'write'],
    },
    account: 'developer@example.com',
    workspace: 'Acme',
  }
  try {
    const first = await manager(root).completeOAuth(completion)
    assert.equal(first.connections.length, 1)
    assert.equal(first.connections[0].authKind, 'oauth')
    const recovered = await manager(root).completeOAuth(completion)
    assert.equal(recovered.connections.length, 1)
    assert.equal(recovered.connections[0].workspace, 'Acme')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('serializes concurrent refreshes and reuses the rotated credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-concurrency-test-'))
  const oauth = new RotatingOAuth()
  try {
    const connections = manager(root, oauth)
    const connected = await connections.completeOAuth(expiredOAuthCompletion('concurrent-flow'))
    const id = connected.connections[0].id
    const [first, second] = await Promise.all([
      connections.resolveCredential(id),
      connections.resolveCredential(id),
    ])

    assert.equal(oauth.refreshCalls, 1)
    assert.equal(first.credential.accessToken, 'new-access')
    assert.equal(second.credential.accessToken, 'new-access')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('waits for an in-flight refresh before revoking and disconnecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-disconnect-race-test-'))
  const oauth = new RotatingOAuth(true)
  try {
    const connections = manager(root, oauth)
    const connected = await connections.completeOAuth(expiredOAuthCompletion('disconnect-race-flow'))
    const id = connected.connections[0].id
    const refresh = connections.resolveCredential(id)
    await oauth.waitForRefresh()
    const disconnect = connections.disconnect({ requestId: 'disconnect-after-refresh', connectionId: id })
    oauth.continueRefresh()

    await refresh
    const snapshot = await disconnect
    assert.equal(oauth.revokedAccessToken, 'new-access')
    assert.equal(snapshot.connections[0].status, 'disconnected')
    const vault = JSON.parse(await readFile(join(root, 'credentials.v1.json'), 'utf8')) as {
      entries: Record<string, unknown>
    }
    assert.deepEqual(vault.entries, {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disconnect removes the credential before a cold restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-disconnect-test-'))
  try {
    const connections = manager(root)
    const connected = await connections.connectApiKey({
      requestId: 'connect-once',
      provider: 'linear',
      apiKey: 'lin_api_disconnect_secret',
      access: 'read-only',
    })
    const connectionId = connected.connections[0].id
    const disconnected = await connections.disconnect({ requestId: 'disconnect-once', connectionId })
    assert.equal(disconnected.connections[0].status, 'disconnected')
    await assert.rejects(connections.resolveCredential(connectionId), /disconnected or missing/)

    const vault = JSON.parse(await readFile(join(root, 'credentials.v1.json'), 'utf8')) as {
      entries: Record<string, unknown>
    }
    assert.deepEqual(vault.entries, {})
    assert.equal(manager(root).snapshot().connections[0].status, 'disconnected')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
