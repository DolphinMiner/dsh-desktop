import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CredentialEncryptionAdapter, CredentialVault, CredentialVaultError } from './credential-vault'

class TestEncryption implements CredentialEncryptionAdapter {
  constructor(readonly enabled = true) {}

  isAvailable(): boolean {
    return this.enabled
  }

  backend(): string {
    return 'test-keychain'
  }

  encrypt(plaintext: string): Buffer {
    return Buffer.from([...Buffer.from(plaintext, 'utf8')].map(byte => byte ^ 0xa5))
  }

  decrypt(ciphertext: Buffer): string {
    return Buffer.from([...ciphertext].map(byte => byte ^ 0xa5)).toString('utf8')
  }
}

test('stores only encrypted credential payloads and restores them after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vault-test-'))
  const path = join(root, 'credentials.v1.json')
  try {
    const vault = new CredentialVault(path, new TestEncryption())
    const reference = vault.put({
      kind: 'oauth',
      accessToken: 'access-secret-value',
      refreshToken: 'refresh-secret-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
      scopes: ['read', 'write'],
    })

    const persisted = await readFile(path, 'utf8')
    assert.equal(persisted.includes('access-secret-value'), false)
    assert.equal(persisted.includes('refresh-secret-value'), false)
    assert.deepEqual(new CredentialVault(path, new TestEncryption()).get(reference), {
      kind: 'oauth',
      accessToken: 'access-secret-value',
      refreshToken: 'refresh-secret-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
      scopes: ['read', 'write'],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed instead of writing plaintext when secure storage is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vault-unavailable-test-'))
  try {
    const vault = new CredentialVault(join(root, 'credentials.v1.json'), new TestEncryption(false))
    assert.throws(() => vault.put({ kind: 'api-key', accessToken: 'secret', scopes: ['read'] }), error => {
      return error instanceof CredentialVaultError && error.code === 'VAULT_UNAVAILABLE'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
