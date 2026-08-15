import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CredentialEncryptionAdapter } from './credential-vault'
import {
  EncryptedOAuthStateStore,
  LinearOAuthCoordinator,
} from './oauth-provider'
import { OAuthCompletion } from './oauth-types'

class TestEncryption implements CredentialEncryptionAdapter {
  isAvailable(): boolean { return true }
  backend(): string { return 'test-keychain' }
  encrypt(value: string): Buffer {
    return Buffer.from([...Buffer.from(value, 'utf8')].map(byte => byte ^ 0x7d))
  }
  decrypt(value: Buffer): string {
    return Buffer.from([...value].map(byte => byte ^ 0x7d)).toString('utf8')
  }
}

function input(requestId = 'oauth-request') {
  return {
    requestId,
    provider: 'linear' as const,
    access: 'read-write' as const,
    label: 'Acme',
  }
}

test('creates idempotent PKCE flows, encrypts recovery state, and validates timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-state-test-'))
  const path = join(root, 'oauth-state.v1.json')
  let now = Date.parse('2026-08-16T00:00:00.000Z')
  const coordinator = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(path, new TestEncryption()),
    { clientId: 'linear-client', now: () => now, flowTtlMs: 60_000 },
  )
  try {
    const first = await coordinator.begin(input())
    const duplicate = await coordinator.begin(input())
    assert.deepEqual(first, duplicate)
    const authorization = new URL(first.authorizationUrl)
    assert.equal(authorization.origin, 'https://linear.app')
    assert.equal(authorization.searchParams.get('scope'), 'read,write')
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.ok((authorization.searchParams.get('code_challenge') ?? '').length > 20)

    const persisted = await readFile(path, 'utf8')
    assert.equal(persisted.includes(authorization.searchParams.get('state') ?? 'missing'), false)
    assert.equal(persisted.includes('code_challenge'), false)

    now += 61_000
    await assert.rejects(
      coordinator.handleCallback(
        `dsh-desktop://oauth/linear/callback?code=unused&state=${authorization.searchParams.get('state')}`,
      ),
      /expired/,
    )
  } finally {
    coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('persists an exchanged token before delivery and recovers it without a second exchange', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-recovery-test-'))
  const path = join(root, 'oauth-state.v1.json')
  let tokenCalls = 0
  const fetcher = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url).includes('/oauth/token')) {
      tokenCalls += 1
      const form = init?.body as URLSearchParams
      assert.equal(form.get('code'), 'authorization-code')
      assert.ok((form.get('code_verifier') ?? '').length > 20)
      return Response.json({
        access_token: 'oauth-access-secret',
        refresh_token: 'oauth-refresh-secret',
        expires_in: 3600,
        scope: 'read write',
      })
    }
    return Response.json({
      data: { viewer: { email: 'developer@example.com', organization: { name: 'Acme' } } },
    })
  }) as typeof fetch

  const first = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(path, new TestEncryption()),
    { clientId: 'linear-client', fetch: fetcher },
  )
  first.setCompletionHandler(() => Promise.reject(new Error('simulated local commit failure')))
  const begin = await first.begin(input())
  const state = new URL(begin.authorizationUrl).searchParams.get('state')
  await assert.rejects(first.handleCallback(
    `dsh-desktop://oauth/linear/callback?code=authorization-code&state=${state}`,
  ), /simulated local commit failure/)
  first.dispose()

  let recovered: OAuthCompletion | undefined
  const restarted = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(path, new TestEncryption()),
    { clientId: 'linear-client', fetch: fetcher },
  )
  try {
    restarted.setCompletionHandler(completion => {
      recovered = completion
      return Promise.resolve()
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(tokenCalls, 1)
    assert.equal(recovered?.credential.accessToken, 'oauth-access-secret')
    assert.equal(recovered?.workspace, 'Acme')
    assert.equal(recovered?.account, 'developer@example.com')
    const persisted = await readFile(path, 'utf8')
    assert.equal(persisted.includes('oauth-access-secret'), false)
    assert.equal(persisted.includes('oauth-refresh-secret'), false)
  } finally {
    restarted.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('rotates an expired refresh token once and revokes without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-refresh-test-'))
  let refreshCalls = 0
  let revokeCalls = 0
  const fetcher = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/token')) {
      refreshCalls += 1
      const form = init?.body as URLSearchParams
      assert.equal(form.get('refresh_token'), 'old-refresh')
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        scope: ['read', 'write'],
      })
    }
    revokeCalls += 1
    const form = init?.body as URLSearchParams
    assert.equal(form.get('token'), 'new-refresh')
    return new Response(null, { status: 200 })
  }) as typeof fetch
  const coordinator = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(join(root, 'state.json'), new TestEncryption()),
    {
      clientId: 'linear-client',
      tokenUrl: 'https://linear.test/token',
      revokeUrl: 'https://linear.test/revoke',
      fetch: fetcher,
      now: () => Date.parse('2026-08-16T00:00:00.000Z'),
    },
  )
  try {
    const refreshed = await coordinator.resolve({
      kind: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2026-08-15T00:00:00.000Z',
      scopes: ['read', 'write'],
    })
    assert.equal(refreshCalls, 1)
    assert.equal(refreshed.accessToken, 'new-access')
    assert.equal(refreshed.refreshToken, 'new-refresh')
    await coordinator.revoke(refreshed)
    assert.equal(revokeCalls, 1)
  } finally {
    coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation removes a flow and rejects its callback before token exchange', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-cancel-test-'))
  let calls = 0
  const coordinator = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(join(root, 'state.json'), new TestEncryption()),
    {
      clientId: 'linear-client',
      fetch: (async () => {
        calls += 1
        return Response.json({})
      }) as typeof fetch,
    },
  )
  try {
    const begin = await coordinator.begin(input('cancel-request'))
    await coordinator.cancel({ requestId: 'cancel-request', flowId: begin.flowId })
    const state = new URL(begin.authorizationUrl).searchParams.get('state')
    await assert.rejects(coordinator.handleCallback(
      `dsh-desktop://oauth/linear/callback?code=unused&state=${state}`,
    ), /unknown or was already used/)
    assert.equal(calls, 0)
  } finally {
    coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('does not replay an OAuth exchange after an ambiguous network result or restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-ambiguous-test-'))
  const path = join(root, 'state.json')
  let calls = 0
  const fetcher = (async (): Promise<Response> => {
    calls += 1
    throw new TypeError('connection reset after dispatch')
  }) as typeof fetch
  const first = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(path, new TestEncryption()),
    { clientId: 'linear-client', fetch: fetcher },
  )
  const begin = await first.begin(input('ambiguous-request'))
  const state = new URL(begin.authorizationUrl).searchParams.get('state')
  const callback = `dsh-desktop://oauth/linear/callback?code=possibly-used&state=${state}`
  await assert.rejects(first.handleCallback(callback), /unknown and was not retried/)
  await assert.rejects(first.handleCallback(callback), /unknown and was not replayed/)
  first.dispose()

  const restarted = new LinearOAuthCoordinator(
    new EncryptedOAuthStateStore(path, new TestEncryption()),
    { clientId: 'linear-client', fetch: fetcher },
  )
  try {
    await assert.rejects(restarted.handleCallback(callback), /unknown and was not replayed/)
    assert.equal(calls, 1)
  } finally {
    restarted.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
