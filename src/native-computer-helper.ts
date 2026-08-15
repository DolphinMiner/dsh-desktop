import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

import {
  ComputerObservation,
  ComputerPermissions,
  ComputerTargetList,
  DesktopProtocolError,
  isDesktopProtocolErrorCode,
  parseComputerObservation,
  parseComputerPermissions,
  parseComputerTargetList,
} from '@dolphinminer/dsh-desktop-protocol'

import { ComputerHelper, ComputerHelperObserveInput, ComputerUseError } from './computer-observer'

const HELPER_PROTOCOL_VERSION = 1
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

interface NativeComputerHelperOptions {
  args?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
}

interface NativeHelperResponse {
  version: number
  id: string
  ok: boolean
  result?: unknown
  error?: {
    code?: unknown
    message?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseResponse(value: unknown, requestId: string): NativeHelperResponse | undefined {
  if (!isRecord(value) || value.version !== HELPER_PROTOCOL_VERSION || value.id !== requestId ||
    typeof value.ok !== 'boolean') return undefined
  if (value.ok) return { version: value.version, id: value.id as string, ok: true, result: value.result }
  if (!isRecord(value.error)) return undefined
  return {
    version: value.version,
    id: value.id as string,
    ok: false,
    error: { code: value.error.code, message: value.error.message },
  }
}

function structuredFailure(response: NativeHelperResponse): ComputerUseError {
  const code = response.error?.code
  const message = response.error?.message
  const supportedCode: DesktopProtocolError['code'] = isDesktopProtocolErrorCode(code)
    ? code
    : 'DESKTOP_UNAVAILABLE'
  return new ComputerUseError(
    supportedCode === 'BAD_MESSAGE' || supportedCode === 'CANCELLED' || supportedCode === 'CONFLICT' ||
      supportedCode === 'DESKTOP_UNAVAILABLE' || supportedCode === 'NOT_FOUND' ||
      supportedCode === 'PERMISSION_DENIED' || supportedCode === 'TARGET_CHANGED' ||
      supportedCode === 'UNSUPPORTED'
      ? supportedCode
      : 'DESKTOP_UNAVAILABLE',
    typeof message === 'string' && message.length > 0 && message.length <= 1_000
      ? message
      : 'The native computer helper failed.',
  )
}

export class NativeComputerHelper implements ComputerHelper {
  private readonly active = new Set<ChildProcessWithoutNullStreams>()
  private readonly args: string[]
  private readonly env?: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private disposed = false
  private verifiedExecutable?: string

  constructor(
    private readonly executable: string,
    options: NativeComputerHelperOptions = {},
  ) {
    this.args = [...(options.args ?? [])]
    this.env = options.env
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  async getPermissions(signal?: AbortSignal): Promise<ComputerPermissions> {
    const value = await this.call('permissions', {}, signal)
    const parsed = parseComputerPermissions(value)
    if (parsed === undefined) throw new ComputerUseError('BAD_MESSAGE', 'The helper returned invalid permissions.')
    return parsed
  }

  async listTargets(signal?: AbortSignal): Promise<ComputerTargetList> {
    const value = await this.call('listTargets', {}, signal)
    const parsed = parseComputerTargetList(value)
    if (parsed === undefined) throw new ComputerUseError('BAD_MESSAGE', 'The helper returned invalid targets.')
    return parsed
  }

  async observe(input: ComputerHelperObserveInput, signal?: AbortSignal): Promise<ComputerObservation> {
    const value = await this.call('observe', input, signal)
    const parsed = parseComputerObservation(value)
    if (parsed === undefined) throw new ComputerUseError('BAD_MESSAGE', 'The helper returned an invalid observation.')
    return parsed
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const child of this.active) child.kill('SIGTERM')
    this.active.clear()
  }

  private async resolveExecutable(): Promise<string> {
    if (this.verifiedExecutable !== undefined) return this.verifiedExecutable
    const resolved = await realpath(this.executable)
    const info = await stat(resolved)
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      throw new ComputerUseError('UNSUPPORTED', 'The native computer helper is missing or not executable.')
    }
    this.verifiedExecutable = resolved
    return resolved
  }

  private async call(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) throw new ComputerUseError('DESKTOP_UNAVAILABLE', 'The computer helper has stopped.')
    if (signal?.aborted === true) throw new DOMException('The computer helper call was cancelled.', 'AbortError')
    const executable = await this.resolveExecutable().catch(error => {
      if (error instanceof ComputerUseError) throw error
      throw new ComputerUseError('UNSUPPORTED', 'The native computer helper is unavailable.')
    })
    const id = randomUUID()
    const request = JSON.stringify({ version: HELPER_PROTOCOL_VERSION, id, method, ...params })

    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let stdout = Buffer.alloc(0)
      let outputOverflow = false
      const child = spawn(executable, this.args, {
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.active.add(child)

      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.active.delete(child)
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const abort = (): void => {
        child.kill('SIGTERM')
        finish(new DOMException('The computer helper call was cancelled.', 'AbortError'))
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new ComputerUseError('DESKTOP_UNAVAILABLE', 'The native computer helper timed out.'))
      }, this.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted === true) {
        abort()
        return
      }

      child.stdout.on('data', (chunk: Buffer) => {
        if (outputOverflow) return
        if (stdout.length + chunk.length > this.maxOutputBytes) {
          outputOverflow = true
          child.kill('SIGKILL')
          return
        }
        stdout = Buffer.concat([stdout, chunk])
      })
      child.stderr.on('data', () => undefined)
      child.on('error', () => {
        finish(new ComputerUseError('DESKTOP_UNAVAILABLE', 'The native computer helper could not start.'))
      })
      child.on('close', () => {
        if (settled) return
        if (outputOverflow) {
          finish(new ComputerUseError('BAD_MESSAGE', 'The native computer helper returned too much data.'))
          return
        }
        let decoded: unknown
        try {
          decoded = JSON.parse(stdout.toString('utf8'))
        } catch {
          finish(new ComputerUseError('DESKTOP_UNAVAILABLE', 'The native computer helper stopped unexpectedly.'))
          return
        }
        const response = parseResponse(decoded, id)
        if (response === undefined) {
          finish(new ComputerUseError('BAD_MESSAGE', 'The native computer helper returned an invalid response.'))
        } else if (!response.ok) {
          finish(structuredFailure(response))
        } else {
          finish(undefined, response.result)
        }
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(request)
    })
  }
}
