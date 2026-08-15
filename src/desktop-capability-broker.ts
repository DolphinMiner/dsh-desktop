import {
  createFailureResponse,
  createSuccessResponse,
  DesktopCapabilityMethod,
  DesktopCapabilityParams,
  DesktopCapabilityResult,
  DesktopProtocolError,
  DesktopResponse,
  isDesktopProtocolErrorCode,
  isSensitiveCapabilityMethod,
  parseCapabilityParams,
  parseDesktopProtocolMessage,
} from '@dolphinminer/dsh-desktop-protocol'

export interface DesktopCapabilityContext {
  requestId: string
  signal: AbortSignal
}

export type DesktopCapabilityHandlers = {
  [M in DesktopCapabilityMethod]: (
    params: DesktopCapabilityParams<M>,
    context: DesktopCapabilityContext,
  ) => DesktopCapabilityResult<M> | Promise<DesktopCapabilityResult<M>>
}

interface InFlightRequest {
  controller: AbortController
  timeout: NodeJS.Timeout
  settled: boolean
}

export interface DesktopCapabilityBrokerOptions {
  requestTimeoutMs?: number
  responseCacheSize?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_RESPONSE_CACHE_SIZE = 256

function internalError(error: unknown): DesktopProtocolError {
  if (typeof error === 'object' && error !== null && 'code' in error &&
    isDesktopProtocolErrorCode(error.code) && 'message' in error &&
    typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error && error.name === 'AbortError'
      ? 'The desktop capability was cancelled.'
      : 'The desktop capability failed.',
    ...(error instanceof Error && error.name === 'AbortError' ? {} : { ambiguous: true }),
  }
}

export class DesktopCapabilityBroker {
  private readonly inFlight = new Map<string, InFlightRequest>()
  private readonly completed = new Map<string, DesktopResponse>()
  private readonly requestTimeoutMs: number
  private readonly responseCacheSize: number

  constructor(
    private readonly handlers: DesktopCapabilityHandlers,
    options: DesktopCapabilityBrokerOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.responseCacheSize = options.responseCacheSize ?? DEFAULT_RESPONSE_CACHE_SIZE
  }

  receive(value: unknown, reply: (response: DesktopResponse) => void): void {
    const message = parseDesktopProtocolMessage(value)
    if (message === undefined || message.kind === 'response' || message.kind === 'event') return

    if (message.kind === 'cancel') {
      this.inFlight.get(message.id)?.controller.abort()
      return
    }

    const cached = this.completed.get(message.id)
    if (cached !== undefined) {
      reply(cached)
      return
    }
    if (this.inFlight.has(message.id)) return

    const method = message.method
    if (!Object.prototype.hasOwnProperty.call(this.handlers, method)) {
      this.complete(message.id, createFailureResponse(message.id, {
        code: 'METHOD_NOT_FOUND',
        message: `Desktop capability ${String(method)} is not available.`,
      }), reply, true)
      return
    }
    const params = parseCapabilityParams(method, message.params)
    if (params === undefined) {
      this.complete(message.id, createFailureResponse(message.id, {
        code: 'BAD_MESSAGE',
        message: `Desktop capability ${String(method)} received invalid parameters.`,
      }), reply, true)
      return
    }

    const controller = new AbortController()
    const inFlight: InFlightRequest = {
      controller,
      settled: false,
      timeout: setTimeout(() => {
        controller.abort()
        this.settle(message.id, createFailureResponse(message.id, {
          code: 'TIMEOUT',
          message: `Desktop capability ${String(method)} timed out.`,
          ambiguous: true,
        }), reply, !isSensitiveCapabilityMethod(method))
      }, this.requestTimeoutMs),
    }
    this.inFlight.set(message.id, inFlight)

    const handler = this.handlers[method] as (
      value: typeof params,
      context: DesktopCapabilityContext,
    ) => unknown | Promise<unknown>
    let result: unknown | Promise<unknown>
    try {
      result = handler(params, { requestId: message.id, signal: controller.signal })
    } catch (error) {
      this.settle(
        message.id,
        createFailureResponse(message.id, internalError(error)),
        reply,
        !isSensitiveCapabilityMethod(method),
      )
      return
    }
    void Promise.resolve(result)
      .then(result => {
        this.settle(
          message.id,
          createSuccessResponse(message.id, result),
          reply,
          !isSensitiveCapabilityMethod(method),
        )
      })
      .catch(error => {
        const failure = controller.signal.aborted
          ? {
              code: 'CANCELLED' as const,
              message: 'The desktop capability was cancelled.',
              ambiguous: true,
            }
          : internalError(error)
        this.settle(
          message.id,
          createFailureResponse(message.id, failure),
          reply,
          !isSensitiveCapabilityMethod(method),
        )
      })
  }

  disconnect(): void {
    for (const request of this.inFlight.values()) {
      clearTimeout(request.timeout)
      request.settled = true
      request.controller.abort()
    }
    this.inFlight.clear()
    this.completed.clear()
  }

  private settle(
    id: string,
    response: DesktopResponse,
    reply: (response: DesktopResponse) => void,
    cache: boolean,
  ): void {
    const request = this.inFlight.get(id)
    if (request === undefined || request.settled) return
    request.settled = true
    clearTimeout(request.timeout)
    this.inFlight.delete(id)
    this.complete(id, response, reply, cache)
  }

  private complete(
    id: string,
    response: DesktopResponse,
    reply: (response: DesktopResponse) => void,
    cache: boolean,
  ): void {
    if (cache) {
      this.completed.set(id, response)
      while (this.completed.size > this.responseCacheSize) {
        const oldest = this.completed.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.completed.delete(oldest)
      }
    }
    reply(response)
  }
}
