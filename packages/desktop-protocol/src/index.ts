export const DESKTOP_PROTOCOL_CHANNEL = 'dsh-desktop' as const
export const DESKTOP_PROTOCOL_VERSION = 1 as const

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

export interface DesktopCapabilityMap {
  'desktop.ping': {
    params: DesktopPingParams
    result: DesktopPingResult
  }
  'desktop.notify': {
    params: DesktopNotificationParams
    result: DesktopNotificationResult
  }
}

export type DesktopCapabilityMethod = keyof DesktopCapabilityMap
export type DesktopCapabilityParams<M extends DesktopCapabilityMethod> = DesktopCapabilityMap[M]['params']
export type DesktopCapabilityResult<M extends DesktopCapabilityMethod> = DesktopCapabilityMap[M]['result']

export interface DesktopProtocolError {
  code:
    | 'BAD_MESSAGE'
    | 'CANCELLED'
    | 'DESKTOP_UNAVAILABLE'
    | 'DUPLICATE_REQUEST'
    | 'INTERNAL_ERROR'
    | 'METHOD_NOT_FOUND'
    | 'TIMEOUT'
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

export type DesktopResponse = DesktopSuccessResponse | DesktopFailureResponse
export type DesktopProtocolMessage = DesktopRequest | DesktopResponse | DesktopCancel

const MAX_ID_LENGTH = 128
const MAX_NONCE_LENGTH = 256
const MAX_TITLE_LENGTH = 120
const MAX_BODY_LENGTH = 1_000
const MAX_SESSION_ID_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function hasEnvelope(value: Record<string, unknown>): boolean {
  return value.channel === DESKTOP_PROTOCOL_CHANNEL && value.version === DESKTOP_PROTOCOL_VERSION
}

function parseError(value: unknown): DesktopProtocolError | undefined {
  if (!isRecord(value) || !isBoundedString(value.code, 64) || !isBoundedString(value.message, 1_000)) {
    return undefined
  }
  const codes: readonly DesktopProtocolError['code'][] = [
    'BAD_MESSAGE',
    'CANCELLED',
    'DESKTOP_UNAVAILABLE',
    'DUPLICATE_REQUEST',
    'INTERNAL_ERROR',
    'METHOD_NOT_FOUND',
    'TIMEOUT',
  ]
  if (!codes.includes(value.code as DesktopProtocolError['code'])) return undefined
  if (value.ambiguous !== undefined && typeof value.ambiguous !== 'boolean') return undefined
  return {
    code: value.code as DesktopProtocolError['code'],
    message: value.message,
    ...(value.ambiguous === undefined ? {} : { ambiguous: value.ambiguous }),
  }
}

export function parseDesktopProtocolMessage(value: unknown): DesktopProtocolMessage | undefined {
  if (!isRecord(value) || !hasEnvelope(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) {
    return undefined
  }

  if (value.kind === 'cancel') {
    return {
      channel: DESKTOP_PROTOCOL_CHANNEL,
      version: DESKTOP_PROTOCOL_VERSION,
      kind: 'cancel',
      id: value.id,
    }
  }

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
  if (value.ok) {
    return {
      channel: DESKTOP_PROTOCOL_CHANNEL,
      version: DESKTOP_PROTOCOL_VERSION,
      kind: 'response',
      id: value.id,
      ok: true,
      result: value.result,
    }
  }
  const error = parseError(value.error)
  if (error === undefined) return undefined
  return {
    channel: DESKTOP_PROTOCOL_CHANNEL,
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'response',
    id: value.id,
    ok: false,
    error,
  }
}

export function parseCapabilityParams<M extends DesktopCapabilityMethod>(
  method: M,
  value: unknown,
): DesktopCapabilityParams<M> | undefined {
  if (!isRecord(value)) return undefined

  if (method === 'desktop.ping') {
    if (!isBoundedString(value.nonce, MAX_NONCE_LENGTH, true)) return undefined
    return { nonce: value.nonce } as DesktopCapabilityParams<M>
  }

  if (method === 'desktop.notify') {
    if (!isBoundedString(value.title, MAX_TITLE_LENGTH)) return undefined
    if (value.body !== undefined && !isBoundedString(value.body, MAX_BODY_LENGTH, true)) return undefined
    if (
      value.sessionId !== undefined &&
      !isBoundedString(value.sessionId, MAX_SESSION_ID_LENGTH)
    ) return undefined
    if (value.level !== undefined && value.level !== 'success' && value.level !== 'error') {
      return undefined
    }
    return {
      title: value.title,
      ...(value.body === undefined ? {} : { body: value.body }),
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      ...(value.level === undefined ? {} : { level: value.level }),
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
    if (
      !isBoundedString(value.nonce, MAX_NONCE_LENGTH, true) ||
      value.protocolVersion !== DESKTOP_PROTOCOL_VERSION
    ) return undefined
    return {
      nonce: value.nonce,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
    } as DesktopCapabilityResult<M>
  }
  if (method === 'desktop.notify') {
    if (typeof value.delivered !== 'boolean') return undefined
    if (value.reason !== undefined && value.reason !== 'foreground' && value.reason !== 'unsupported') {
      return undefined
    }
    return {
      delivered: value.delivered,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    } as DesktopCapabilityResult<M>
  }
  return undefined
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

export function createFailureResponse(
  id: string,
  error: DesktopProtocolError,
): DesktopFailureResponse {
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
