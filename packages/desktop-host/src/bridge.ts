import { randomUUID } from 'node:crypto'

import {
  createCancel,
  createRequest,
  DesktopCapabilityMethod,
  DesktopCapabilityParams,
  DesktopCapabilityResult,
  DesktopProtocolError,
  parseCapabilityResult,
  parseDesktopProtocolMessage,
} from '@dolphinminer/dsh-desktop-protocol'

export interface DesktopIpcTransport {
  readonly connected: boolean
  send(message: unknown): boolean
  onMessage(listener: (message: unknown) => void): () => void
  onDisconnect(listener: () => void): () => void
}

interface PendingRequest {
  method: DesktopCapabilityMethod
  resolve: (result: unknown) => void
  reject: (error: DesktopCapabilityError) => void
  timeout: NodeJS.Timeout
  removeAbort?: () => void
}

export class DesktopCapabilityError extends Error {
  constructor(
    readonly code: DesktopProtocolError['code'],
    message: string,
    readonly ambiguous = false,
  ) {
    super(message)
    this.name = 'DesktopCapabilityError'
  }
}

export interface DesktopCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export class DesktopCapabilityClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly removeMessageListener: () => void
  private readonly removeDisconnectListener: () => void
  private disposed = false

  constructor(private readonly transport: DesktopIpcTransport) {
    this.removeMessageListener = transport.onMessage(message => this.receive(message))
    this.removeDisconnectListener = transport.onDisconnect(() => {
      this.rejectAll(new DesktopCapabilityError(
        'DESKTOP_UNAVAILABLE',
        'The desktop host disconnected before the request completed.',
        true,
      ))
    })
  }

  call<M extends DesktopCapabilityMethod>(
    method: M,
    params: DesktopCapabilityParams<M>,
    options: DesktopCallOptions = {},
  ): Promise<DesktopCapabilityResult<M>> {
    if (this.disposed || !this.transport.connected) {
      return Promise.reject(new DesktopCapabilityError(
        'DESKTOP_UNAVAILABLE',
        'This Harness process is not attached to DSH Desktop.',
      ))
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new DesktopCapabilityError('CANCELLED', 'The desktop request was cancelled.'))
    }

    const id = randomUUID()
    const timeoutMs = options.timeoutMs ?? 10_000
    return new Promise<DesktopCapabilityResult<M>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.take(id)
        if (pending === undefined) return
        this.transport.send(createCancel(id))
        pending.reject(new DesktopCapabilityError(
          'TIMEOUT',
          `Desktop capability ${method} timed out.`,
          true,
        ))
      }, timeoutMs)

      const pending: PendingRequest = {
        method,
        resolve: result => resolve(result as DesktopCapabilityResult<M>),
        reject,
        timeout,
      }
      if (options.signal !== undefined) {
        const abort = (): void => {
          const current = this.take(id)
          if (current === undefined) return
          this.transport.send(createCancel(id))
          current.reject(new DesktopCapabilityError(
            'CANCELLED',
            'The desktop request was cancelled.',
            true,
          ))
        }
        options.signal.addEventListener('abort', abort, { once: true })
        pending.removeAbort = () => options.signal?.removeEventListener('abort', abort)
      }
      this.pending.set(id, pending)

      if (!this.transport.send(createRequest(id, method, params))) {
        const current = this.take(id)
        current?.reject(new DesktopCapabilityError(
          'DESKTOP_UNAVAILABLE',
          'The desktop host did not accept the request.',
          true,
        ))
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeMessageListener()
    this.removeDisconnectListener()
    this.rejectAll(new DesktopCapabilityError(
      'DESKTOP_UNAVAILABLE',
      'The desktop bridge was disposed.',
      true,
    ))
  }

  private receive(value: unknown): void {
    const message = parseDesktopProtocolMessage(value)
    if (message?.kind !== 'response') return
    const pending = this.take(message.id)
    if (pending === undefined) return
    if (!message.ok) {
      pending.reject(new DesktopCapabilityError(
        message.error.code,
        message.error.message,
        message.error.ambiguous ?? false,
      ))
      return
    }
    const result = parseCapabilityResult(pending.method, message.result)
    if (result === undefined) {
      pending.reject(new DesktopCapabilityError(
        'BAD_MESSAGE',
        `The desktop host returned an invalid ${pending.method} response.`,
      ))
      return
    }
    pending.resolve(result)
  }

  private take(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id)
    if (pending === undefined) return undefined
    this.pending.delete(id)
    clearTimeout(pending.timeout)
    pending.removeAbort?.()
    return pending
  }

  private rejectAll(error: DesktopCapabilityError): void {
    for (const id of [...this.pending.keys()]) this.take(id)?.reject(error)
  }
}

export function processIpcTransport(): DesktopIpcTransport {
  const messageListeners = new Map<(message: unknown) => void, (message: unknown) => void>()
  const disconnectListeners = new Map<() => void, () => void>()
  return {
    get connected() {
      return typeof process.send === 'function' && process.connected
    },
    send(message) {
      if (typeof process.send !== 'function' || !process.connected) return false
      try {
        return process.send(message)
      } catch {
        return false
      }
    },
    onMessage(listener) {
      const wrapped = (message: unknown): void => listener(message)
      messageListeners.set(listener, wrapped)
      process.on('message', wrapped)
      return () => {
        const current = messageListeners.get(listener)
        if (current === undefined) return
        process.off('message', current)
        messageListeners.delete(listener)
      }
    },
    onDisconnect(listener) {
      const wrapped = (): void => listener()
      disconnectListeners.set(listener, wrapped)
      process.on('disconnect', wrapped)
      return () => {
        const current = disconnectListeners.get(listener)
        if (current === undefined) return
        process.off('disconnect', current)
        disconnectListeners.delete(listener)
      }
    },
  }
}
