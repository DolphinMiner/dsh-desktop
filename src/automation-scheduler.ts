import type { AutomationDefinition } from '@dolphinminer/dsh-desktop-protocol'

import {
  AutomationRegistry,
  ScheduledAutomationAdmission,
} from './automation-registry'
import {
  latestDueAutomationOccurrence,
  nextAutomationOccurrence,
} from './automation-schedule'

const MAX_TIMER_DELAY_MS = 2_147_000_000

export interface AutomationSchedulerEvaluation {
  observedAt: string
  admissions: ScheduledAutomationAdmission[]
  coalesced: boolean
}

export interface AutomationSchedulerStatus {
  running: boolean
  evaluating: boolean
  lastEvaluatedAt?: string
  lastError?: string
  nextWakeAt?: string
}

export interface AutomationSchedulerOptions {
  now?: () => Date
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  onAdmissions?: (admissions: readonly ScheduledAutomationAdmission[]) => void
  onError?: (error: Error) => void
}

function operationId(automationId: string, occurrenceAt: string): string {
  return `schedule:${automationId}:${occurrenceAt}`
}

function nextEnabledWake(definitions: readonly AutomationDefinition[]): string | undefined {
  return definitions
    .flatMap(definition => definition.state === 'enabled' && definition.nextTriggerAt !== undefined
      ? [definition.nextTriggerAt]
      : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0]
}

export class AutomationScheduler {
  private running = false
  private evaluating = false
  private timer?: unknown
  private lastEvaluatedAt?: string
  private lastError?: string
  private nextWakeAt?: string
  private readonly now: () => Date
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly onAdmissions?: (admissions: readonly ScheduledAutomationAdmission[]) => void
  private readonly onError?: (error: Error) => void

  constructor(
    private readonly registry: AutomationRegistry,
    options: AutomationSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.onAdmissions = options.onAdmissions
    this.onError = options.onError
  }

  status(): AutomationSchedulerStatus {
    return {
      running: this.running,
      evaluating: this.evaluating,
      ...(this.lastEvaluatedAt === undefined ? {} : { lastEvaluatedAt: this.lastEvaluatedAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.nextWakeAt === undefined ? {} : { nextWakeAt: this.nextWakeAt }),
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.runCycle()
  }

  refresh(): void {
    if (!this.running) return
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    this.runCycle()
  }

  stop(): void {
    this.running = false
    this.nextWakeAt = undefined
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  evaluateDue(now = this.now()): AutomationSchedulerEvaluation {
    const observedAt = now.toISOString()
    if (this.evaluating) return { observedAt, admissions: [], coalesced: true }
    this.evaluating = true
    const admissions: ScheduledAutomationAdmission[] = []
    try {
      const definitions = [...this.registry.snapshot().automations]
        .sort((left, right) => left.id.localeCompare(right.id))
      for (const definition of definitions) {
        if (definition.state !== 'enabled' || definition.nextTriggerAt === undefined) continue
        const occurrenceAt = latestDueAutomationOccurrence(
          definition.trigger,
          definition.nextTriggerAt,
          observedAt,
        )
        if (occurrenceAt === undefined) continue
        admissions.push(this.registry.admitScheduledRun({
          operationId: operationId(definition.id, occurrenceAt),
          automationId: definition.id,
          expectedRevision: definition.revision,
          expectedNextTriggerAt: definition.nextTriggerAt,
          occurrenceAt,
          nextTriggerAt: nextAutomationOccurrence(definition.trigger, occurrenceAt),
        }))
      }
      this.lastEvaluatedAt = observedAt
      this.lastError = undefined
      return { observedAt, admissions, coalesced: false }
    } finally {
      this.evaluating = false
      if (admissions.length > 0 && this.onAdmissions !== undefined) {
        try {
          this.onAdmissions(admissions)
        } catch {
          // The durable registry is authoritative; a wakeup callback is best effort.
        }
      }
    }
  }

  private runCycle(): void {
    if (!this.running) return
    this.timer = undefined
    try {
      this.evaluateDue(this.now())
      this.armNextWakeup()
    } catch (error) {
      const exactError = error instanceof Error ? error : new Error(String(error))
      this.running = false
      this.lastError = exactError.message
      this.nextWakeAt = undefined
      try {
        this.onError?.(exactError)
      } catch {
        // Scheduler state remains authoritative even if diagnostics fail.
      }
    }
  }

  private armNextWakeup(): void {
    if (!this.running) return
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    const next = nextEnabledWake(this.registry.snapshot().automations)
    this.nextWakeAt = next
    if (next === undefined) return
    const delayMs = Math.max(0, Math.min(Date.parse(next) - this.now().getTime(), MAX_TIMER_DELAY_MS))
    this.timer = this.setTimer(() => this.runCycle(), delayMs)
  }
}
