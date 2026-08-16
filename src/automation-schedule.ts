import { CronExpressionParser } from 'cron-parser'

import type { AutomationTrigger } from '@dolphinminer/dsh-desktop-protocol'

const MAX_FILTERED_OCCURRENCES = 32

export class AutomationScheduleError extends Error {
  constructor(
    readonly code: 'INVALID_DATE' | 'INVALID_TRIGGER',
    message: string,
  ) {
    super(message)
    this.name = 'AutomationScheduleError'
  }
}

function canonicalTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new AutomationScheduleError('INVALID_DATE', 'The automation schedule anchor is invalid.')
  }
  return date.toISOString()
}

function parseCron(trigger: Extract<AutomationTrigger, { kind: 'cron' }>, currentDate: Date) {
  if (trigger.expression.split(/\s+/).length !== 5 || /(^|[^A-Za-z])H(?:\b|\()/i.test(trigger.expression)) {
    throw new AutomationScheduleError(
      'INVALID_TRIGGER',
      'The automation cadence must be a deterministic five-field cron expression.',
    )
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trigger.timeZone }).format(currentDate)
    return CronExpressionParser.parse(trigger.expression, {
      currentDate,
      tz: trigger.timeZone,
    })
  } catch {
    throw new AutomationScheduleError('INVALID_TRIGGER', 'The automation cadence or time zone is invalid.')
  }
}

function localParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.flatMap(part =>
    part.type === 'literal' ? [] : [[part.type, Number(part.value)]],
  ))
}

function localKey(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone)
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join(':')
}

function offsetMinutes(date: Date, timeZone: string): number {
  const parts = localParts(date, timeZone)
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  )
  return Math.round((asUtc - Math.floor(date.getTime() / 1_000) * 1_000) / 60_000)
}

function isLaterRepeatedOccurrence(date: Date, timeZone: string): boolean {
  const currentOffset = offsetMinutes(date, timeZone)
  const localMillis = date.getTime() + currentOffset * 60_000
  const nearbyOffsets = new Set([
    offsetMinutes(new Date(date.getTime() - 24 * 60 * 60 * 1_000), timeZone),
    offsetMinutes(new Date(date.getTime() + 24 * 60 * 60 * 1_000), timeZone),
  ])
  const key = localKey(date, timeZone)
  for (const offset of nearbyOffsets) {
    if (offset === currentOffset) continue
    const alternate = new Date(localMillis - offset * 60_000)
    if (alternate.getTime() < date.getTime() && localKey(alternate, timeZone) === key) return true
  }
  return false
}

export function validateAutomationTrigger(trigger: AutomationTrigger): void {
  if (trigger.kind === 'once') {
    if (canonicalTimestamp(trigger.at) !== trigger.at) {
      throw new AutomationScheduleError('INVALID_TRIGGER', 'The one-shot trigger must use canonical UTC time.')
    }
    return
  }
  parseCron(trigger, new Date('2026-01-01T00:00:00.000Z'))
}

export function nextAutomationOccurrence(
  trigger: AutomationTrigger,
  afterExclusive: string | Date,
): string | undefined {
  const anchor = canonicalTimestamp(afterExclusive)
  if (trigger.kind === 'once') {
    validateAutomationTrigger(trigger)
    return Date.parse(trigger.at) > Date.parse(anchor) ? trigger.at : undefined
  }
  const expression = parseCron(trigger, new Date(anchor))
  for (let attempt = 0; attempt < MAX_FILTERED_OCCURRENCES; attempt += 1) {
    const candidate = expression.next()
    const date = candidate.toDate()
    if (expression.includesDate(candidate) && !isLaterRepeatedOccurrence(date, trigger.timeZone)) {
      return date.toISOString()
    }
  }
  throw new AutomationScheduleError('INVALID_TRIGGER', 'The automation cadence did not produce a valid occurrence.')
}

export function isAutomationOccurrence(trigger: AutomationTrigger, timestamp: string): boolean {
  const candidate = canonicalTimestamp(timestamp)
  const previousMillisecond = new Date(Date.parse(candidate) - 1)
  return nextAutomationOccurrence(trigger, previousMillisecond) === candidate
}

export function latestDueAutomationOccurrence(
  trigger: AutomationTrigger,
  earliestOccurrence: string,
  nowInclusive: string | Date,
): string | undefined {
  const earliest = canonicalTimestamp(earliestOccurrence)
  const now = canonicalTimestamp(nowInclusive)
  if (Date.parse(earliest) > Date.parse(now)) return undefined
  if (trigger.kind === 'once') {
    validateAutomationTrigger(trigger)
    return trigger.at === earliest && Date.parse(trigger.at) <= Date.parse(now) ? trigger.at : undefined
  }
  const expression = parseCron(trigger, new Date(Date.parse(now) + 1))
  for (let attempt = 0; attempt < MAX_FILTERED_OCCURRENCES; attempt += 1) {
    const candidate = expression.prev()
    const date = candidate.toDate()
    if (date.getTime() < Date.parse(earliest)) return undefined
    if (expression.includesDate(candidate) && !isLaterRepeatedOccurrence(date, trigger.timeZone)) {
      return date.toISOString()
    }
  }
  throw new AutomationScheduleError('INVALID_TRIGGER', 'The automation cadence did not produce a valid occurrence.')
}
