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

import { ConnectionManager, OAuthConnectionProvider } from './connection-manager'
import { ConnectionRegistry } from './connection-registry'
import { CredentialEncryptionAdapter, CredentialVault } from './credential-vault'

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
  readonly available = false
  begin(_input: BeginOAuthInput): Promise<BeginOAuthResult> { throw new Error('not configured') }
  cancel(_input: CancelOAuthInput): Promise<void> { return Promise.resolve() }
  resolve(value: ConnectionCredential): Promise<ConnectionCredential> { return Promise.resolve(value) }
  revoke(_value: ConnectionCredential): Promise<void> { return Promise.resolve() }
}

function manager(root: string): ConnectionManager {
  return new ConnectionManager(
    new ConnectionRegistry(join(root, 'connections.v1.json')),
    new CredentialVault(join(root, 'credentials.v1.json'), new TestEncryption()),
    new TestOAuth(),
  )
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

    const restarted = manager(root).snapshot()
    assert.equal(restarted.connections.length, 2)
    assert.equal(restarted.connections[0].status, 'connecting')
    assert.deepEqual(restarted.connections[0].enabledTools, ['mcp__linear_acme__list_issues'])
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
