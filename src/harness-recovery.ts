export interface HarnessRecoverySchedule {
  attempt: number
  maxAttempts: number
  delayMs: number
  retryAt: string
}

export interface HarnessRecoveryOptions {
  start(): Promise<void>
  onSchedule(schedule: HarnessRecoverySchedule): void
  onExhausted(maxAttempts: number): void
  onStartError?(error: unknown): void
  delaysMs?: readonly number[]
  failureWindowMs?: number
  now?: () => number
}

const DEFAULT_DELAYS_MS = [1_000, 3_000, 10_000] as const
const DEFAULT_FAILURE_WINDOW_MS = 60_000

export class HarnessRecoveryController {
  private readonly delaysMs: readonly number[]
  private readonly failureWindowMs: number
  private readonly now: () => number
  private failures: number[] = []
  private timer?: NodeJS.Timeout
  private stopped = false

  constructor(private readonly options: HarnessRecoveryOptions) {
    this.delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS
    this.failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  handleUnexpectedFailure(): void {
    if (this.stopped || this.timer !== undefined) return

    const now = this.now()
    this.failures = this.failures.filter(timestamp => now - timestamp <= this.failureWindowMs)
    if (this.failures.length >= this.delaysMs.length) {
      this.options.onExhausted(this.delaysMs.length)
      return
    }

    this.failures.push(now)
    const attempt = this.failures.length
    const delayMs = this.delaysMs[attempt - 1]!
    this.options.onSchedule({
      attempt,
      maxAttempts: this.delaysMs.length,
      delayMs,
      retryAt: new Date(now + delayMs).toISOString(),
    })
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.start().catch(() => undefined)
    }, delayMs)
  }

  async restartNow(): Promise<void> {
    if (this.stopped) throw new Error('Harness recovery has stopped.')
    this.cancelPending()
    this.failures = []
    await this.start()
  }

  stop(): void {
    this.stopped = true
    this.cancelPending()
  }

  private async start(): Promise<void> {
    if (this.stopped) return
    try {
      await this.options.start()
    } catch (error) {
      if (this.stopped) return
      this.options.onStartError?.(error)
      this.handleUnexpectedFailure()
    }
  }

  private cancelPending(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
