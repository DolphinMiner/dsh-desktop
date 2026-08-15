import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectionCredential,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'
import { ConnectionManagerError } from './connection-manager'
import { CredentialEncryptionAdapter } from './credential-vault'
import { OAuthCompletion, OAuthConnectionProvider } from './oauth-types'

const OAUTH_STATE_SCHEMA_VERSION = 1
const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1_000
const EXCHANGED_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000
const REFRESH_EARLY_MS = 5 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 15_000

interface WaitingFlow {
  phase: 'waiting'
  flowId: string
  requestId: string
  state: string
  verifier: string
  input: BeginOAuthInput
  createdAt: string
  expiresAt: string
}

interface ExchangedFlow {
  phase: 'exchanged'
  flowId: string
  requestId: string
  completion: OAuthCompletion
  createdAt: string
  expiresAt: string
}

interface ExchangingFlow extends Omit<WaitingFlow, 'phase'> {
  phase: 'exchanging'
}

interface AmbiguousFlow extends Omit<WaitingFlow, 'phase'> {
  phase: 'ambiguous'
}

interface ExpiredFlow {
  phase: 'expired'
  flowId: string
  requestId: string
  state: string
  createdAt: string
  expiresAt: string
}

type StoredFlow = WaitingFlow | ExchangingFlow | AmbiguousFlow | ExchangedFlow | ExpiredFlow

interface OAuthStateDocument {
  schemaVersion: typeof OAUTH_STATE_SCHEMA_VERSION
  ciphertext: string
}

export class EncryptedOAuthStateStore {
  constructor(
    private readonly path: string,
    private readonly encryption: CredentialEncryptionAdapter,
  ) {}

  get available(): boolean {
    return this.encryption.isAvailable()
  }

  load(): StoredFlow[] {
    if (!this.available) return []
    const value = readJsonFile(this.path)
    if (value === undefined) return []
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('The OAuth recovery store has an invalid document shape.')
    }
    const document = value as Partial<OAuthStateDocument>
    if (document.schemaVersion !== OAUTH_STATE_SCHEMA_VERSION || typeof document.ciphertext !== 'string') {
      throw new Error('The OAuth recovery store uses an unsupported schema version.')
    }
    const plaintext = this.encryption.decrypt(Buffer.from(document.ciphertext, 'base64'))
    const flows = JSON.parse(plaintext) as unknown
    if (!Array.isArray(flows)) throw new Error('The OAuth recovery payload is invalid.')
    return flows.map(parseStoredFlow)
  }

  save(flows: readonly StoredFlow[]): void {
    if (!this.available) {
      throw new ConnectionManagerError(
        'VAULT_UNAVAILABLE',
        'Secure credential storage is unavailable. Unlock the macOS login Keychain and try again.',
      )
    }
    const ciphertext = this.encryption.encrypt(JSON.stringify(flows)).toString('base64')
    writeJsonAtomically(this.path, {
      schemaVersion: OAUTH_STATE_SCHEMA_VERSION,
      ciphertext,
    } satisfies OAuthStateDocument)
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid OAuth ${name}.`)
  return value
}

function parseCredential(value: unknown): ConnectionCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid OAuth credential.')
  }
  const item = value as Partial<ConnectionCredential>
  if (item.kind !== 'oauth' || typeof item.accessToken !== 'string' || !Array.isArray(item.scopes) ||
    !item.scopes.every(scope => typeof scope === 'string')) {
    throw new Error('Invalid OAuth credential fields.')
  }
  return {
    kind: 'oauth',
    accessToken: item.accessToken,
    ...(typeof item.refreshToken === 'string' ? { refreshToken: item.refreshToken } : {}),
    ...(typeof item.expiresAt === 'string' ? { expiresAt: item.expiresAt } : {}),
    scopes: [...item.scopes],
  }
}

function parseInput(value: unknown): BeginOAuthInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid OAuth connection input.')
  }
  const item = value as Partial<BeginOAuthInput>
  if (typeof item.requestId !== 'string' || item.provider !== 'linear' ||
    (item.access !== 'read-only' && item.access !== 'read-write')) {
    throw new Error('Invalid OAuth connection input fields.')
  }
  return {
    requestId: item.requestId,
    provider: 'linear',
    access: item.access,
    ...(typeof item.label === 'string' ? { label: item.label } : {}),
    ...(typeof item.connectionId === 'string' ? { connectionId: item.connectionId } : {}),
  }
}

function parseCompletion(value: unknown): OAuthCompletion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid OAuth completion.')
  }
  const item = value as Partial<OAuthCompletion>
  return {
    flowId: string(item.flowId, 'flow ID'),
    input: parseInput(item.input),
    credential: parseCredential(item.credential),
    ...(typeof item.account === 'string' ? { account: item.account } : {}),
    ...(typeof item.workspace === 'string' ? { workspace: item.workspace } : {}),
  }
}

function parseStoredFlow(value: unknown): StoredFlow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid OAuth recovery flow.')
  }
  const item = value as Partial<StoredFlow>
  const base = {
    flowId: string(item.flowId, 'flow ID'),
    requestId: string(item.requestId, 'request ID'),
    createdAt: string(item.createdAt, 'creation time'),
    expiresAt: string(item.expiresAt, 'expiry time'),
  }
  if (item.phase === 'waiting' || item.phase === 'exchanging' || item.phase === 'ambiguous') {
    const waiting = item as Partial<WaitingFlow>
    return {
      phase: item.phase,
      ...base,
      state: string(waiting.state, 'state'),
      verifier: string(waiting.verifier, 'PKCE verifier'),
      input: parseInput(waiting.input),
    }
  }
  if (item.phase === 'exchanged') {
    const exchanged = item as Partial<ExchangedFlow>
    return { phase: 'exchanged', ...base, completion: parseCompletion(exchanged.completion) }
  }
  if (item.phase === 'expired') {
    const expired = item as Partial<ExpiredFlow>
    return { phase: 'expired', ...base, state: string(expired.state, 'state') }
  }
  throw new Error('Invalid OAuth recovery phase.')
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresIn: number
  scopes: string[]
}

function parseScopes(value: unknown, fallback: readonly string[]): string[] {
  if (typeof value === 'string') {
    const scopes = value.split(/[ ,]+/).filter(Boolean)
    if (scopes.length > 0) return scopes
  }
  if (Array.isArray(value) && value.every(scope => typeof scope === 'string')) return [...value]
  return [...fallback]
}

async function parseTokenResponse(response: Response, fallbackScopes: readonly string[]): Promise<TokenResponse> {
  if (!response.ok) {
    const code = response.status === 400 || response.status === 401 ? 'AUTH_EXPIRED' : 'INTERNAL_ERROR'
    throw new ConnectionManagerError(code, 'Linear did not accept the OAuth token request.')
  }
  const value = await response.json() as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectionManagerError('INTERNAL_ERROR', 'Linear returned an invalid OAuth response.')
  }
  const item = value as Record<string, unknown>
  if (typeof item.access_token !== 'string' || item.access_token.length === 0 ||
    typeof item.expires_in !== 'number' || !Number.isFinite(item.expires_in) || item.expires_in <= 0) {
    throw new ConnectionManagerError('INTERNAL_ERROR', 'Linear returned incomplete OAuth credentials.')
  }
  return {
    accessToken: item.access_token,
    ...(typeof item.refresh_token === 'string' ? { refreshToken: item.refresh_token } : {}),
    expiresIn: item.expires_in,
    scopes: parseScopes(item.scope, fallbackScopes),
  }
}

export interface LinearOAuthCoordinatorOptions {
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  authorizeUrl?: string
  tokenUrl?: string
  revokeUrl?: string
  graphqlUrl?: string
  fetch?: typeof fetch
  now?: () => number
  flowTtlMs?: number
}

export class LinearOAuthCoordinator implements OAuthConnectionProvider {
  readonly available: boolean
  private readonly flows = new Map<string, StoredFlow>()
  private readonly callbackOperations = new Map<string, Promise<void>>()
  private readonly callbackControllers = new Map<string, AbortController>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly flowTtlMs: number
  private readonly clientId: string
  private readonly clientSecret?: string
  private readonly redirectUri: string
  private readonly authorizeUrl: string
  private readonly tokenUrl: string
  private readonly revokeUrl: string
  private readonly graphqlUrl: string
  private completionHandler?: (completion: OAuthCompletion) => Promise<void>
  private expiryTimer?: NodeJS.Timeout

  constructor(
    private readonly store: EncryptedOAuthStateStore,
    options: LinearOAuthCoordinatorOptions = {},
  ) {
    this.clientId = options.clientId?.trim() ?? ''
    this.clientSecret = options.clientSecret?.trim() || undefined
    this.redirectUri = options.redirectUri ?? 'dsh-desktop://oauth/linear/callback'
    this.authorizeUrl = options.authorizeUrl ?? 'https://linear.app/oauth/authorize'
    this.tokenUrl = options.tokenUrl ?? 'https://api.linear.app/oauth/token'
    this.revokeUrl = options.revokeUrl ?? 'https://api.linear.app/oauth/revoke'
    this.graphqlUrl = options.graphqlUrl ?? 'https://api.linear.app/graphql'
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS
    this.available = this.clientId.length > 0 && store.available
    for (const flow of store.load()) this.flows.set(flow.flowId, flow)
    this.pruneExpired()
    this.scheduleExpiry()
  }

  async begin(input: BeginOAuthInput, _signal?: AbortSignal): Promise<BeginOAuthResult> {
    this.assertAvailable()
    const duplicate = [...this.flows.values()].find(flow =>
      flow.phase === 'waiting' && flow.requestId === input.requestId,
    )
    if (duplicate?.phase === 'waiting') return this.beginResult(duplicate)

    for (const [flowId, flow] of this.flows) {
      if (flow.phase !== 'waiting' && flow.phase !== 'exchanging' && flow.phase !== 'ambiguous') continue
      if (input.connectionId !== undefined && flow.input.connectionId === input.connectionId) {
        this.flows.delete(flowId)
      }
    }

    const now = this.now()
    const verifier = base64Url(randomBytes(48))
    const flow: WaitingFlow = {
      phase: 'waiting',
      flowId: randomUUID(),
      requestId: input.requestId,
      state: base64Url(randomBytes(32)),
      verifier,
      input: { ...input },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.flowTtlMs).toISOString(),
    }
    this.flows.set(flow.flowId, flow)
    this.persist()
    this.scheduleExpiry()
    return this.beginResult(flow)
  }

  cancel(input: CancelOAuthInput): Promise<void> {
    const flow = this.flows.get(input.flowId)
    if (flow !== undefined && flow.requestId === input.requestId && flow.phase !== 'exchanged') {
      this.callbackControllers.get(input.flowId)?.abort()
      this.flows.delete(input.flowId)
      this.persist()
      this.scheduleExpiry()
    }
    return Promise.resolve()
  }

  setCompletionHandler(handler: (completion: OAuthCompletion) => Promise<void>): void {
    this.completionHandler = handler
    void this.recoverExchanged()
  }

  async handleCallback(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl)
    if (url.protocol !== 'dsh-desktop:' || url.hostname !== 'oauth' ||
      url.pathname !== '/linear/callback') {
      throw new ConnectionManagerError('BAD_MESSAGE', 'The OAuth callback URL is invalid.')
    }
    const state = url.searchParams.get('state')
    if (state === null) throw new ConnectionManagerError('BAD_MESSAGE', 'The OAuth callback has no state.')
    const flow = [...this.flows.values()].find(item =>
      item.phase !== 'exchanged' && equalSecret(item.state, state),
    )
    if (flow?.phase === 'expired') {
      this.remove(flow.flowId)
      throw new ConnectionManagerError('TIMEOUT', 'The OAuth authorization request expired.')
    }
    if (flow === undefined) {
      throw new ConnectionManagerError('BAD_MESSAGE', 'The OAuth state is unknown or was already used.')
    }
    const existing = this.callbackOperations.get(flow.flowId)
    if (existing !== undefined) return existing
    if (flow.phase === 'exchanging' || flow.phase === 'ambiguous') {
      throw new ConnectionManagerError(
        'CONFLICT',
        'The OAuth exchange result is unknown and was not replayed. Start a new connection flow.',
      )
    }
    if (flow.phase !== 'waiting') {
      throw new ConnectionManagerError('BAD_MESSAGE', 'The OAuth state is no longer active.')
    }
    const controller = new AbortController()
    this.callbackControllers.set(flow.flowId, controller)
    const operation = this.completeCallback(flow, url, controller.signal).finally(() => {
      this.callbackOperations.delete(flow.flowId)
      this.callbackControllers.delete(flow.flowId)
    })
    this.callbackOperations.set(flow.flowId, operation)
    return operation
  }

  async resolve(credential: ConnectionCredential, signal?: AbortSignal): Promise<ConnectionCredential> {
    if (credential.kind !== 'oauth') return credential
    const expiresAt = credential.expiresAt === undefined ? 0 : Date.parse(credential.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt > this.now() + REFRESH_EARLY_MS) return credential
    if (credential.refreshToken === undefined) {
      throw new ConnectionManagerError('AUTH_EXPIRED', 'The Linear authorization has expired. Reconnect it.')
    }
    this.assertAvailable()
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: this.clientId,
    })
    if (this.clientSecret !== undefined) form.set('client_secret', this.clientSecret)
    let response: Response
    try {
      response = await this.fetcher(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: this.requestSignal(signal),
      })
    } catch {
      throw new ConnectionManagerError(
        'INTERNAL_ERROR',
        'The Linear token refresh result is unknown. It was not retried automatically.',
      )
    }
    const token = await parseTokenResponse(response, credential.scopes)
    return {
      kind: 'oauth',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? credential.refreshToken,
      expiresAt: new Date(this.now() + token.expiresIn * 1_000).toISOString(),
      scopes: token.scopes,
    }
  }

  async revoke(credential: ConnectionCredential, signal?: AbortSignal): Promise<void> {
    if (credential.kind !== 'oauth') return
    const token = credential.refreshToken ?? credential.accessToken
    const form = new URLSearchParams({
      token,
      token_type_hint: credential.refreshToken === undefined ? 'access_token' : 'refresh_token',
    })
    let response: Response
    try {
      response = await this.fetcher(this.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: this.requestSignal(signal),
      })
    } catch {
      throw new ConnectionManagerError(
        'INTERNAL_ERROR',
        'Linear token revocation could not be confirmed. It was not retried automatically.',
      )
    }
    if (response.status === 200 || response.status === 400 || response.status === 401) return
    throw new ConnectionManagerError('INTERNAL_ERROR', 'Linear token revocation was not accepted.')
  }

  dispose(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    for (const controller of this.callbackControllers.values()) controller.abort()
    this.callbackControllers.clear()
  }

  private async completeCallback(flow: WaitingFlow, url: URL, signal: AbortSignal): Promise<void> {
    if (Date.parse(flow.expiresAt) <= this.now()) {
      this.remove(flow.flowId)
      throw new ConnectionManagerError('TIMEOUT', 'The OAuth authorization request expired.')
    }
    const providerError = url.searchParams.get('error')
    if (providerError !== null) {
      this.remove(flow.flowId)
      throw new ConnectionManagerError('CANCELLED', 'Linear authorization was cancelled.')
    }
    const code = url.searchParams.get('code')
    if (code === null || code.length === 0) {
      throw new ConnectionManagerError('BAD_MESSAGE', 'The OAuth callback has no authorization code.')
    }
    const fallbackScopes = flow.input.access === 'read-only' ? ['read'] : ['read', 'write']
    const form = new URLSearchParams({
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: flow.verifier,
      grant_type: 'authorization_code',
    })
    if (this.clientSecret !== undefined) form.set('client_secret', this.clientSecret)
    const exchanging: ExchangingFlow = {
      ...flow,
      phase: 'exchanging',
      expiresAt: new Date(this.now() + EXCHANGED_RECOVERY_TTL_MS).toISOString(),
    }
    this.flows.set(flow.flowId, exchanging)
    this.persist()
    this.scheduleExpiry()

    let response: Response
    try {
      response = await this.fetcher(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
    } catch {
      if (signal.aborted && !this.flows.has(flow.flowId)) {
        throw new ConnectionManagerError('CANCELLED', 'Linear authorization was cancelled.')
      }
      this.markAmbiguous(exchanging)
      throw new ConnectionManagerError(
        'CONFLICT',
        'The OAuth exchange result is unknown and was not retried automatically. Start a new connection flow.',
      )
    }
    let token: TokenResponse
    try {
      token = await parseTokenResponse(response, fallbackScopes)
    } catch (error) {
      this.remove(flow.flowId)
      throw error
    }
    const completion: OAuthCompletion = {
      flowId: flow.flowId,
      input: flow.input,
      credential: {
        kind: 'oauth',
        accessToken: token.accessToken,
        ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
        expiresAt: new Date(this.now() + token.expiresIn * 1_000).toISOString(),
        scopes: token.scopes,
      },
    }
    const exchanged: ExchangedFlow = {
      phase: 'exchanged',
      flowId: flow.flowId,
      requestId: flow.requestId,
      completion,
      createdAt: flow.createdAt,
      expiresAt: new Date(this.now() + EXCHANGED_RECOVERY_TTL_MS).toISOString(),
    }
    this.flows.set(flow.flowId, exchanged)
    this.persist()
    this.scheduleExpiry()

    const identity = await this.identity(token.accessToken, new AbortController().signal).catch(() => ({}))
    if (Object.keys(identity).length > 0) {
      exchanged.completion = { ...exchanged.completion, ...identity }
      this.flows.set(flow.flowId, exchanged)
      this.persist()
    }
    await this.deliver(exchanged)
  }

  private async identity(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<{ account?: string; workspace?: string }> {
    const response = await this.fetcher(this.graphqlUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: 'query DesktopOAuthViewer { viewer { name email organization { name } } }',
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!response.ok) return {}
    const value = await response.json() as {
      data?: { viewer?: { name?: unknown; email?: unknown; organization?: { name?: unknown } } }
    }
    const viewer = value.data?.viewer
    const account = typeof viewer?.email === 'string'
      ? viewer.email
      : typeof viewer?.name === 'string' ? viewer.name : undefined
    const workspace = typeof viewer?.organization?.name === 'string'
      ? viewer.organization.name
      : undefined
    return {
      ...(account === undefined ? {} : { account }),
      ...(workspace === undefined ? {} : { workspace }),
    }
  }

  private beginResult(flow: WaitingFlow): BeginOAuthResult {
    const url = new URL(this.authorizeUrl)
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', flow.input.access === 'read-only' ? 'read' : 'read,write')
    url.searchParams.set('state', flow.state)
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('actor', 'user')
    url.searchParams.set('code_challenge', base64Url(createHash('sha256').update(flow.verifier).digest()))
    url.searchParams.set('code_challenge_method', 'S256')
    return { flowId: flow.flowId, authorizationUrl: url.href, expiresAt: flow.expiresAt }
  }

  private async recoverExchanged(): Promise<void> {
    for (const flow of [...this.flows.values()]) {
      if (flow.phase !== 'exchanged') continue
      try {
        await this.deliver(flow)
      } catch {
        return
      }
    }
  }

  private async deliver(flow: ExchangedFlow): Promise<void> {
    if (this.completionHandler === undefined) return
    await this.completionHandler(flow.completion)
    this.remove(flow.flowId)
  }

  private remove(flowId: string): void {
    this.flows.delete(flowId)
    this.persist()
    this.scheduleExpiry()
  }

  private markAmbiguous(flow: ExchangingFlow): void {
    const ambiguous: AmbiguousFlow = { ...flow, phase: 'ambiguous' }
    this.flows.set(flow.flowId, ambiguous)
    this.persist()
    this.scheduleExpiry()
  }

  private persist(): void {
    this.store.save([...this.flows.values()])
  }

  private pruneExpired(): void {
    const now = this.now()
    let changed = false
    for (const [flowId, flow] of this.flows) {
      if (Date.parse(flow.expiresAt) > now) continue
      if (flow.phase === 'waiting') {
        this.flows.set(flowId, {
          phase: 'expired',
          flowId: flow.flowId,
          requestId: flow.requestId,
          state: flow.state,
          createdAt: flow.createdAt,
          expiresAt: new Date(now + EXCHANGED_RECOVERY_TTL_MS).toISOString(),
        })
      } else {
        this.flows.delete(flowId)
      }
      changed = true
    }
    if (changed) this.persist()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    const next = Math.min(...[...this.flows.values()].map(flow => Date.parse(flow.expiresAt)))
    if (!Number.isFinite(next)) {
      this.expiryTimer = undefined
      return
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      this.pruneExpired()
      this.scheduleExpiry()
    }, Math.max(1, next - this.now()))
    this.expiryTimer.unref()
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new ConnectionManagerError(
        'OAUTH_UNAVAILABLE',
        'Linear OAuth is not configured in this build. Connect with an API key instead.',
      )
    }
  }
}

export class UnavailableOAuthProvider implements OAuthConnectionProvider {
  readonly available = false

  begin(_input: BeginOAuthInput, _signal?: AbortSignal): Promise<BeginOAuthResult> {
    return Promise.reject(new ConnectionManagerError(
      'OAUTH_UNAVAILABLE',
      'Linear OAuth is not configured in this build.',
    ))
  }

  cancel(_input: CancelOAuthInput): Promise<void> { return Promise.resolve() }
  resolve(credential: ConnectionCredential): Promise<ConnectionCredential> {
    return Promise.resolve(credential)
  }
  revoke(_credential: ConnectionCredential): Promise<void> { return Promise.resolve() }
  setCompletionHandler(_handler: (completion: OAuthCompletion) => Promise<void>): void {}
  handleCallback(_url: string): Promise<void> {
    return Promise.reject(new ConnectionManagerError('OAUTH_UNAVAILABLE', 'Linear OAuth is unavailable.'))
  }
}
