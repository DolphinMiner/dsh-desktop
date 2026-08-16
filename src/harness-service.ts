import { ChildProcess, Serializable, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'

import { DesktopCapabilityBroker } from './desktop-capability-broker'
import { LineBuffer, parseHarnessUrl } from './harness-output'
import { HarnessState } from './types'

interface HarnessServiceOptions {
  dshBin: string
  dshHome: string
  cwd: string
  logPath: string
  nodeExecutable: string
  env?: NodeJS.ProcessEnv
  profileName?: string
  startupTimeoutMs?: number
  capabilityBroker?: DesktopCapabilityBroker
  onDisconnect?: () => void
  onUnexpectedFailure?: (state: HarnessState) => void
  onState: (state: HarnessState) => void
}

const STOP_TIMEOUT_MS = 5_000

function messageLabel(message: Serializable): string {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return 'unknown'
  const value = message as { id?: unknown; kind?: unknown; method?: unknown }
  const kind = typeof value.kind === 'string' ? value.kind : 'unknown'
  const method = typeof value.method === 'string' ? ` ${value.method}` : ''
  const id = typeof value.id === 'string' ? ` (${value.id})` : ''
  return `${kind}${method}${id}`
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 1_000 === 0) {
    const seconds = milliseconds / 1_000
    return `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`
  }

  return `${String(milliseconds)} milliseconds`
}

export class HarnessService {
  private child?: ChildProcess
  private log?: WriteStream
  private logClosing?: Promise<void>
  private startupTimer?: NodeJS.Timeout
  private runId = 0
  private failedRunId?: number
  private stopping = false
  private readyCandidate = false

  constructor(private readonly options: HarnessServiceOptions) {}

  async start(): Promise<void> {
    await this.stop()

    const runId = ++this.runId
    this.stopping = false
    this.readyCandidate = false
    mkdirSync(dirname(this.options.logPath), { recursive: true })
    mkdirSync(this.options.dshHome, { recursive: true })
    const log = createWriteStream(this.options.logPath, { flags: 'a' })
    log.on('error', () => {
      if (this.log === log) this.log = undefined
    })
    this.log = log
    this.writeDesktopLog(`starting Harness with ${this.options.dshBin}`)
    this.publish({
      phase: 'starting',
      message: 'Starting the local Harness runtime...',
      logPath: this.options.logPath,
    })

    const child = spawn(
      this.options.nodeExecutable,
      [
        '--expose-internals',
        this.options.dshBin,
        '--profile',
        this.options.profileName ?? 'desktop',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
      ],
      {
        cwd: this.options.cwd,
        serialization: 'advanced',
        env: {
          ...process.env,
          ...this.options.env,
          DSH_HOME: this.options.dshHome,
          ELECTRON_RUN_AS_NODE: '1',
          FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    )
    this.child = child

    const stdout = new LineBuffer()
    const stderr = new LineBuffer()

    const childStdout = child.stdout as Readable
    const childStderr = child.stderr as Readable
    childStdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.log?.write(`[stdout] ${text}`)
      for (const line of stdout.push(text)) this.inspectLine(line, runId)
    })

    childStderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.log?.write(`[stderr] ${text}`)
      for (const line of stderr.push(text)) this.writeDesktopLog(`Harness stderr: ${line}`)
    })

    child.once('error', error => {
      if (runId !== this.runId || this.stopping) return
      this.fail(`Harness could not start: ${error.message}`, runId)
      void this.stop()
    })

    child.on('message', message => {
      if (runId !== this.runId || this.stopping || this.child !== child) return
      this.writeDesktopLog(`received desktop IPC ${messageLabel(message)}`)
      this.options.capabilityBroker?.receive(message, response => {
        if (runId !== this.runId || this.stopping || this.child !== child || !child.connected) return
        this.writeDesktopLog(`sending desktop IPC ${messageLabel(response)}`)
        child.send(response, error => {
          if (error !== null) this.writeDesktopLog(`could not send desktop capability response: ${error.message}`)
        })
      })
    })

    child.once('disconnect', () => {
      if (this.child === child) {
        this.options.capabilityBroker?.disconnect()
        this.options.onDisconnect?.()
      }
    })

    child.once('exit', (code, signal) => {
      const stdoutTail = stdout.flush()
      if (stdoutTail !== undefined) this.inspectLine(stdoutTail, runId)
      const stderrTail = stderr.flush()
      if (stderrTail !== undefined) this.writeDesktopLog(`Harness stderr: ${stderrTail}`)

      if (this.child === child) this.child = undefined
      this.options.capabilityBroker?.disconnect()
      this.options.onDisconnect?.()
      this.clearStartupTimer()

      if (runId === this.runId && !this.stopping) {
        const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
        this.fail(`Harness stopped unexpectedly (${detail}).`, runId)
      }
      void this.closeLog()
    })

    const startupTimeoutMs = this.options.startupTimeoutMs ?? 60_000
    this.startupTimer = setTimeout(() => {
      if (runId !== this.runId || this.stopping) return
      this.fail(`Harness did not become ready within ${formatDuration(startupTimeoutMs)}.`, runId)
      void this.stop()
    }, startupTimeoutMs)
  }

  async stop(): Promise<void> {
    this.runId += 1
    this.stopping = true
    this.clearStartupTimer()
    this.options.capabilityBroker?.disconnect()

    const child = this.child
    if (child === undefined) {
      await this.closeLog()
      return
    }

    this.child = undefined
    this.writeDesktopLog('stopping Harness')

    await new Promise<void>(resolve => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        resolve()
      }
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        settle()
      }, STOP_TIMEOUT_MS)

      child.once('exit', settle)
      if (!child.kill('SIGTERM')) settle()
    })

    await this.closeLog()
  }

  send(message: Serializable): boolean {
    const child = this.child
    if (child === undefined || !child.connected || this.stopping) return false
    try {
      return child.send(message)
    } catch {
      return false
    }
  }

  private inspectLine(line: string, runId: number): void {
    if (runId !== this.runId || this.stopping || this.readyCandidate) return
    const url = parseHarnessUrl(line)
    if (url === undefined) return

    this.readyCandidate = true
    void this.confirmReady(url, runId)
  }

  private async confirmReady(url: string, runId: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 350))
    if (runId !== this.runId || this.stopping || this.child === undefined) return

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    } catch (error) {
      if (runId !== this.runId || this.stopping) return
      const detail = error instanceof Error ? error.message : String(error)
      this.fail(`Harness announced a URL but did not become healthy: ${detail}`, runId)
      void this.stop()
      return
    }

    if (runId !== this.runId || this.stopping || this.child === undefined) return
    this.clearStartupTimer()
    this.writeDesktopLog(`Harness ready at ${url}`)
    this.publish({
      phase: 'ready',
      message: 'Harness is ready.',
      url,
      logPath: this.options.logPath,
    })
  }

  private fail(message: string, runId: number): void {
    if (runId !== this.runId || this.stopping || this.failedRunId === runId) return
    this.failedRunId = runId
    this.writeDesktopLog(message)
    const state: HarnessState = { phase: 'error', message, logPath: this.options.logPath }
    this.publish(state)
    this.options.onUnexpectedFailure?.(state)
  }

  private publish(state: HarnessState): void {
    this.options.onState(state)
  }

  private clearStartupTimer(): void {
    if (this.startupTimer === undefined) return
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  private closeLog(): Promise<void> {
    if (this.logClosing !== undefined) return this.logClosing

    const log = this.log
    this.log = undefined
    if (log === undefined) return Promise.resolve()

    const closing = new Promise<void>(resolve => {
      const finish = (): void => {
        log.off('finish', finish)
        log.off('error', finish)
        resolve()
      }
      log.once('finish', finish)
      log.once('error', finish)
      log.end()
    }).finally(() => {
      this.logClosing = undefined
    })
    this.logClosing = closing
    return closing
  }

  private writeDesktopLog(message: string): void {
    this.log?.write(`[desktop ${new Date().toISOString()}] ${message}\n`)
  }
}
