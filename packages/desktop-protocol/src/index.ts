export const DESKTOP_PROTOCOL_CHANNEL = 'dsh-desktop' as const
export const DESKTOP_PROTOCOL_VERSION = 2 as const

export type ConnectionProvider = 'linear'
export type ConnectionAccess = 'read-only' | 'read-write'
export type ConnectionAuthKind = 'api-key' | 'oauth'
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'error'

export interface ConnectionSummary {
  id: string
  provider: ConnectionProvider
  label: string
  account?: string
  workspace?: string
  authKind: ConnectionAuthKind
  access: ConnectionAccess
  scopes: string[]
  status: ConnectionStatus
  statusMessage?: string
  enabledTools: string[]
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

export interface ConnectionSnapshot {
  revision: number
  vault: {
    available: boolean
    backend?: string
  }
  oauth: {
    linear: {
      available: boolean
    }
  }
  connections: ConnectionSummary[]
}

export interface ConnectApiKeyInput {
  requestId: string
  provider: 'linear'
  apiKey: string
  access: ConnectionAccess
  label?: string
  connectionId?: string
}

export interface DisconnectConnectionInput {
  requestId: string
  connectionId: string
}

export interface BeginOAuthInput {
  requestId: string
  provider: 'linear'
  access: ConnectionAccess
  label?: string
  connectionId?: string
}

export interface BeginOAuthResult {
  flowId: string
  authorizationUrl: string
  expiresAt: string
}

export interface CancelOAuthInput {
  requestId: string
  flowId: string
}

export interface DesktopPingParams {
  nonce: string
}

export interface DesktopPingResult {
  nonce: string
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
}

export interface DesktopNotificationParams {
  title: string
  body?: string
  sessionId?: string
  level?: 'success' | 'error'
}

export interface DesktopNotificationResult {
  delivered: boolean
  reason?: 'foreground' | 'unsupported'
}

export interface ConnectionCredential {
  kind: ConnectionAuthKind
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scopes: string[]
}

export type McpTransportDescriptor = {
  transport: 'streamable-http'
  serverName: string
  url: string
} | {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export interface ConnectionRuntimeStatusParams {
  connectionId: string
  status: Extract<ConnectionStatus, 'connecting' | 'connected' | 'expired' | 'error'>
  statusMessage?: string
  enabledTools?: string[]
}

export interface DesktopCapabilityMap {
  'desktop.ping': {
    params: DesktopPingParams
    result: DesktopPingResult
  }
  'desktop.notify': {
    params: DesktopNotificationParams
    result: DesktopNotificationResult
  }
  'connections.list': {
    params: Record<string, never>
    result: ConnectionSnapshot
  }
  'connections.resolveMcpTransport': {
    params: { connectionId: string }
    result: { connection: ConnectionSummary; transport: McpTransportDescriptor }
  }
  'connections.reportStatus': {
    params: ConnectionRuntimeStatusParams
    result: { accepted: boolean; revision: number }
  }
}

export interface DesktopEventMap {
  'connections.changed': {
    revision: number
  }
}

export type DesktopCapabilityMethod = keyof DesktopCapabilityMap
export type DesktopCapabilityParams<M extends DesktopCapabilityMethod> = DesktopCapabilityMap[M]['params']
export type DesktopCapabilityResult<M extends DesktopCapabilityMethod> = DesktopCapabilityMap[M]['result']
export type DesktopEventName = keyof DesktopEventMap
export type DesktopEventData<E extends DesktopEventName> = DesktopEventMap[E]

export interface DesktopProtocolError {
  code:
    | 'BAD_MESSAGE'
    | 'CANCELLED'
    | 'CONFLICT'
    | 'DESKTOP_UNAVAILABLE'
    | 'DUPLICATE_REQUEST'
    | 'INTERNAL_ERROR'
    | 'METHOD_NOT_FOUND'
    | 'NOT_FOUND'
    | 'OAUTH_UNAVAILABLE'
    | 'TIMEOUT'
    | 'VAULT_UNAVAILABLE'
  message: string
  ambiguous?: boolean
}

export interface DesktopRequest<M extends DesktopCapabilityMethod = DesktopCapabilityMethod> {
  channel: typeof DESKTOP_PROTOCOL_CHANNEL
  version: typeof DESKTOP_PROTOCOL_VERSION
  kind: 'request'
  id: string
  method: M
  params: DesktopCapabilityParams<M>
}

export interface DesktopSuccessResponse {
  channel: typeof DESKTOP_PROTOCOL_CHANNEL
  version: typeof DESKTOP_PROTOCOL_VERSION
  kind: 'response'
  id: string
  ok: true
  result: unknown
}

export interface DesktopFailureResponse {
  channel: typeof DESKTOP_PROTOCOL_CHANNEL
  version: typeof DESKTOP_PROTOCOL_VERSION
  kind: 'response'
  id: string
  ok: false
  error: DesktopProtocolError
}

export interface DesktopCancel {
  channel: typeof DESKTOP_PROTOCOL_CHANNEL
  version: typeof DESKTOP_PROTOCOL_VERSION
  kind: 'cancel'
  id: string
}

export interface DesktopEvent<E extends DesktopEventName = DesktopEventName> {
  channel: typeof DESKTOP_PROTOCOL_CHANNEL
  version: typeof DESKTOP_PROTOCOL_VERSION
  kind: 'event'
  event: E
  data: DesktopEventData<E>
}

export type DesktopResponse = DesktopSuccessResponse | DesktopFailureResponse
export type DesktopProtocolMessage = DesktopRequest | DesktopResponse | DesktopCancel | DesktopEvent

const MAX_ID_LENGTH = 128
const MAX_NONCE_LENGTH = 256
const MAX_TITLE_LENGTH = 120
const MAX_BODY_LENGTH = 1_000
const MAX_SESSION_ID_LENGTH = 256
const MAX_TOKEN_LENGTH = 32_768
const MAX_LABEL_LENGTH = 160
const MAX_STATUS_MESSAGE_LENGTH = 1_000
const MAX_LIST_ITEMS = 1_000

const ERROR_CODES: readonly DesktopProtocolError['code'][] = [
  'BAD_MESSAGE', 'CANCELLED', 'CONFLICT', 'DESKTOP_UNAVAILABLE', 'DUPLICATE_REQUEST',
  'INTERNAL_ERROR', 'METHOD_NOT_FOUND', 'NOT_FOUND', 'OAUTH_UNAVAILABLE', 'TIMEOUT',
  'VAULT_UNAVAILABLE',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

function isStringList(value: unknown, maxItemLength = 256): value is string[] {
  return Array.isArray(value) && value.length <= MAX_LIST_ITEMS &&
    value.every(item => isBoundedString(item, maxItemLength))
}

function hasEnvelope(value: Record<string, unknown>): boolean {
  return value.channel === DESKTOP_PROTOCOL_CHANNEL && value.version === DESKTOP_PROTOCOL_VERSION
}

function isConnectionAccess(value: unknown): value is ConnectionAccess {
  return value === 'read-only' || value === 'read-write'
}

function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return value === 'connecting' || value === 'connected' || value === 'disconnected' ||
    value === 'expired' || value === 'error'
}

function parseConnectionSummary(value: unknown): ConnectionSummary | undefined {
  if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH) || value.provider !== 'linear' ||
    !isBoundedString(value.label, MAX_LABEL_LENGTH) ||
    (value.authKind !== 'api-key' && value.authKind !== 'oauth') ||
    !isConnectionAccess(value.access) || !isStringList(value.scopes) ||
    !isConnectionStatus(value.status) || !isStringList(value.enabledTools) ||
    !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) return undefined
  if (value.account !== undefined && !isBoundedString(value.account, MAX_LABEL_LENGTH)) return undefined
  if (value.workspace !== undefined && !isBoundedString(value.workspace, MAX_LABEL_LENGTH)) return undefined
  if (value.statusMessage !== undefined && !isBoundedString(value.statusMessage, MAX_STATUS_MESSAGE_LENGTH, true)) return undefined
  if (value.lastConnectedAt !== undefined && !isIsoDate(value.lastConnectedAt)) return undefined
  return {
    id: value.id,
    provider: 'linear',
    label: value.label,
    ...(value.account === undefined ? {} : { account: value.account }),
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
    authKind: value.authKind,
    access: value.access,
    scopes: [...value.scopes],
    status: value.status,
    ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage }),
    enabledTools: [...value.enabledTools],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.lastConnectedAt === undefined ? {} : { lastConnectedAt: value.lastConnectedAt }),
  }
}

function parseConnectionSnapshot(value: unknown): ConnectionSnapshot | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !isRecord(value.vault) || typeof value.vault.available !== 'boolean' ||
    (value.vault.backend !== undefined && !isBoundedString(value.vault.backend, 128)) ||
    !isRecord(value.oauth) || !isRecord(value.oauth.linear) ||
    typeof value.oauth.linear.available !== 'boolean' || !Array.isArray(value.connections) ||
    value.connections.length > MAX_LIST_ITEMS) return undefined
  const connections = value.connections.map(parseConnectionSummary)
  if (connections.some(connection => connection === undefined)) return undefined
  return {
    revision: Number(value.revision),
    vault: {
      available: value.vault.available,
      ...(value.vault.backend === undefined ? {} : { backend: value.vault.backend }),
    },
    oauth: { linear: { available: value.oauth.linear.available } },
    connections: connections as ConnectionSummary[],
  }
}

function parseMcpTransport(value: unknown): McpTransportDescriptor | undefined {
  if (!isRecord(value) || !isBoundedString(value.serverName, 32) ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(value.serverName)) return undefined
  if (value.transport === 'streamable-http') {
    if (!isBoundedString(value.url, 2_048)) return undefined
    try {
      const url = new URL(value.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return undefined
    } catch {
      return undefined
    }
    return { transport: 'streamable-http', serverName: value.serverName, url: value.url }
  }
  if (value.transport !== 'stdio' || !isBoundedString(value.command, 1_024) ||
    !isStringList(value.args, 4_096) || !isRecord(value.env) ||
    !Object.values(value.env).every(item => typeof item === 'string') ||
    !isBoundedString(value.cwd, 4_096, true)) return undefined
  return {
    transport: 'stdio',
    serverName: value.serverName,
    command: value.command,
    args: [...value.args],
    env: { ...value.env } as Record<string, string>,
    cwd: value.cwd,
  }
}

function parseError(value: unknown): DesktopProtocolError | undefined {
  if (!isRecord(value) || !isBoundedString(value.code, 64) || !isBoundedString(value.message, 1_000)) {
    return undefined
  }
  if (!isDesktopProtocolErrorCode(value.code)) return undefined
  if (value.ambiguous !== undefined && typeof value.ambiguous !== 'boolean') return undefined
  return {
    code: value.code as DesktopProtocolError['code'],
    message: value.message,
    ...(value.ambiguous === undefined ? {} : { ambiguous: value.ambiguous }),
  }
}

export function isDesktopProtocolErrorCode(value: unknown): value is DesktopProtocolError['code'] {
  return typeof value === 'string' && ERROR_CODES.includes(value as DesktopProtocolError['code'])
}

export function parseConnectApiKeyInput(value: unknown): ConnectApiKeyInput | undefined {
  if (!isRecord(value) || !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    value.provider !== 'linear' || !isBoundedString(value.apiKey, MAX_TOKEN_LENGTH) ||
    !isConnectionAccess(value.access) ||
    (value.label !== undefined && !isBoundedString(value.label, MAX_LABEL_LENGTH, true)) ||
    (value.connectionId !== undefined && !isBoundedString(value.connectionId, MAX_ID_LENGTH))) {
    return undefined
  }
  return {
    requestId: value.requestId,
    provider: 'linear',
    apiKey: value.apiKey,
    access: value.access,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId }),
  }
}

export function parseDisconnectConnectionInput(value: unknown): DisconnectConnectionInput | undefined {
  if (!isRecord(value) || !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    !isBoundedString(value.connectionId, MAX_ID_LENGTH)) return undefined
  return { requestId: value.requestId, connectionId: value.connectionId }
}

export function parseBeginOAuthInput(value: unknown): BeginOAuthInput | undefined {
  if (!isRecord(value) || !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    value.provider !== 'linear' || !isConnectionAccess(value.access) ||
    (value.label !== undefined && !isBoundedString(value.label, MAX_LABEL_LENGTH, true)) ||
    (value.connectionId !== undefined && !isBoundedString(value.connectionId, MAX_ID_LENGTH))) {
    return undefined
  }
  return {
    requestId: value.requestId,
    provider: 'linear',
    access: value.access,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId }),
  }
}

export function parseCancelOAuthInput(value: unknown): CancelOAuthInput | undefined {
  if (!isRecord(value) || !isBoundedString(value.requestId, MAX_ID_LENGTH) ||
    !isBoundedString(value.flowId, MAX_ID_LENGTH)) return undefined
  return { requestId: value.requestId, flowId: value.flowId }
}

export function parseDesktopProtocolMessage(value: unknown): DesktopProtocolMessage | undefined {
  if (!isRecord(value) || !hasEnvelope(value)) return undefined

  if (value.kind === 'event') {
    if (value.event !== 'connections.changed' || !isRecord(value.data) ||
      !Number.isSafeInteger(value.data.revision) || Number(value.data.revision) < 0) return undefined
    return createEvent('connections.changed', { revision: Number(value.data.revision) })
  }

  if (!isBoundedString(value.id, MAX_ID_LENGTH)) return undefined
  if (value.kind === 'cancel') return createCancel(value.id)

  if (value.kind === 'request') {
    if (!isBoundedString(value.method, 128) || !isRecord(value.params)) return undefined
    return {
      channel: DESKTOP_PROTOCOL_CHANNEL,
      version: DESKTOP_PROTOCOL_VERSION,
      kind: 'request',
      id: value.id,
      method: value.method as DesktopCapabilityMethod,
      params: value.params as never,
    }
  }

  if (value.kind !== 'response' || typeof value.ok !== 'boolean') return undefined
  if (value.ok) return createSuccessResponse(value.id, value.result)
  const error = parseError(value.error)
  return error === undefined ? undefined : createFailureResponse(value.id, error)
}

export function parseCapabilityParams<M extends DesktopCapabilityMethod>(
  method: M,
  value: unknown,
): DesktopCapabilityParams<M> | undefined {
  if (!isRecord(value)) return undefined

  if (method === 'desktop.ping') {
    return isBoundedString(value.nonce, MAX_NONCE_LENGTH, true)
      ? { nonce: value.nonce } as DesktopCapabilityParams<M>
      : undefined
  }
  if (method === 'desktop.notify') {
    if (!isBoundedString(value.title, MAX_TITLE_LENGTH) ||
      (value.body !== undefined && !isBoundedString(value.body, MAX_BODY_LENGTH, true)) ||
      (value.sessionId !== undefined && !isBoundedString(value.sessionId, MAX_SESSION_ID_LENGTH)) ||
      (value.level !== undefined && value.level !== 'success' && value.level !== 'error')) return undefined
    return {
      title: value.title,
      ...(value.body === undefined ? {} : { body: value.body }),
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      ...(value.level === undefined ? {} : { level: value.level }),
    } as DesktopCapabilityParams<M>
  }
  if (method === 'connections.list') {
    return Object.keys(value).length === 0 ? {} as DesktopCapabilityParams<M> : undefined
  }
  if (method === 'connections.resolveMcpTransport') {
    return isBoundedString(value.connectionId, MAX_ID_LENGTH)
      ? { connectionId: value.connectionId } as DesktopCapabilityParams<M>
      : undefined
  }
  if (method === 'connections.reportStatus') {
    if (!isBoundedString(value.connectionId, MAX_ID_LENGTH) ||
      (value.status !== 'connecting' && value.status !== 'connected' &&
        value.status !== 'expired' && value.status !== 'error') ||
      (value.statusMessage !== undefined &&
        !isBoundedString(value.statusMessage, MAX_STATUS_MESSAGE_LENGTH, true)) ||
      (value.enabledTools !== undefined && !isStringList(value.enabledTools))) return undefined
    return {
      connectionId: value.connectionId,
      status: value.status,
      ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage }),
      ...(value.enabledTools === undefined ? {} : { enabledTools: [...value.enabledTools] }),
    } as DesktopCapabilityParams<M>
  }
  return undefined
}

export function parseCapabilityResult<M extends DesktopCapabilityMethod>(
  method: M,
  value: unknown,
): DesktopCapabilityResult<M> | undefined {
  if (!isRecord(value)) return undefined
  if (method === 'desktop.ping') {
    if (!isBoundedString(value.nonce, MAX_NONCE_LENGTH, true) ||
      value.protocolVersion !== DESKTOP_PROTOCOL_VERSION) return undefined
    return { nonce: value.nonce, protocolVersion: DESKTOP_PROTOCOL_VERSION } as DesktopCapabilityResult<M>
  }
  if (method === 'desktop.notify') {
    if (typeof value.delivered !== 'boolean' ||
      (value.reason !== undefined && value.reason !== 'foreground' && value.reason !== 'unsupported')) return undefined
    return {
      delivered: value.delivered,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    } as DesktopCapabilityResult<M>
  }
  if (method === 'connections.list') {
    return parseConnectionSnapshot(value) as DesktopCapabilityResult<M> | undefined
  }
  if (method === 'connections.resolveMcpTransport') {
    const connection = parseConnectionSummary(value.connection)
    const transport = parseMcpTransport(value.transport)
    return connection === undefined || transport === undefined
      ? undefined
      : { connection, transport } as DesktopCapabilityResult<M>
  }
  if (method === 'connections.reportStatus') {
    if (typeof value.accepted !== 'boolean' || !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0) return undefined
    return { accepted: value.accepted, revision: Number(value.revision) } as DesktopCapabilityResult<M>
  }
  return undefined
}

export function parseConnectionSnapshotResult(value: unknown): ConnectionSnapshot | undefined {
  return parseConnectionSnapshot(value)
}

export function createRequest<M extends DesktopCapabilityMethod>(
  id: string,
  method: M,
  params: DesktopCapabilityParams<M>,
): DesktopRequest<M> {
  return {
    channel: DESKTOP_PROTOCOL_CHANNEL,
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'request',
    id,
    method,
    params,
  }
}

export function createSuccessResponse(id: string, result: unknown): DesktopSuccessResponse {
  return {
    channel: DESKTOP_PROTOCOL_CHANNEL,
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'response',
    id,
    ok: true,
    result,
  }
}

export function createFailureResponse(id: string, error: DesktopProtocolError): DesktopFailureResponse {
  return {
    channel: DESKTOP_PROTOCOL_CHANNEL,
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'response',
    id,
    ok: false,
    error,
  }
}

export function createCancel(id: string): DesktopCancel {
  return {
    channel: DESKTOP_PROTOCOL_CHANNEL,
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'cancel',
    id,
  }
}

export function createEvent<E extends DesktopEventName>(
  event: E,
  data: DesktopEventData<E>,
): DesktopEvent<E> {
  return {
    channel: DESKTOP_PROTOCOL_CHANNEL,
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'event',
    event,
    data,
  }
}

export function isSensitiveCapabilityMethod(method: DesktopCapabilityMethod): boolean {
  return method === 'connections.resolveMcpTransport'
}

const READ_ONLY_MCP_TOOL_PREFIXES = [
  'get_',
  'list_',
  'search_',
  'find_',
  'query_',
  'read_',
  'lookup_',
  'fetch_',
  'view_',
] as const

export function isLikelyReadOnlyMcpTool(name: string): boolean {
  const normalized = name.toLowerCase()
  return READ_ONLY_MCP_TOOL_PREFIXES.some(prefix => normalized.startsWith(prefix))
}
