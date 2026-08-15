import {
  ComputerAction,
  ComputerActionSummary,
  ComputerTarget,
  parseComputerActionSummary,
  parseComputerTarget,
  summarizeComputerAction,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

const AUDIT_VERSION = 1 as const
const DEFAULT_MAX_ACTIONS = 10_000
const MAX_ACTIONS_ON_DISK = 10_000
const MAX_ID_LENGTH = 256

export type ComputerActionAuditPhase =
  | 'intent'
  | 'approved'
  | 'dispatch'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ambiguous'

export type ComputerActionAuditReason =
  | 'completed'
  | 'cancelled-before-dispatch'
  | 'helper-rejected'
  | 'helper-result-ambiguous'
  | 'interrupted-before-dispatch'
  | 'interrupted-after-dispatch'
  | 'observation-failed'

export interface ComputerActionAuditEvent {
  sequence: number
  phase: ComputerActionAuditPhase
  at: string
  reason?: ComputerActionAuditReason
  resultSnapshotId?: string
}

export interface ComputerActionAuditRecord {
  actionId: string
  sessionId: string
  sourceSnapshotId: string
  target: ComputerTarget
  action: ComputerActionSummary
  events: ComputerActionAuditEvent[]
}

interface ComputerActionAuditState {
  version: typeof AUDIT_VERSION
  nextSequence: number
  actions: ComputerActionAuditRecord[]
}

export interface ComputerActionAuditStoreOptions {
  maxActions?: number
  now?: () => Date
}

export class ComputerActionAuditError extends Error {
  constructor(
    readonly code: 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'ComputerActionAuditError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isBoundedString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isActionId(value: unknown): value is string {
  return isBoundedString(value, 36) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

function isPhase(value: unknown): value is ComputerActionAuditPhase {
  return value === 'intent' || value === 'approved' || value === 'dispatch' ||
    value === 'succeeded' || value === 'failed' || value === 'cancelled' || value === 'ambiguous'
}

function isReason(value: unknown): value is ComputerActionAuditReason {
  return value === 'completed' || value === 'cancelled-before-dispatch' ||
    value === 'helper-rejected' || value === 'helper-result-ambiguous' ||
    value === 'interrupted-before-dispatch' || value === 'interrupted-after-dispatch' ||
    value === 'observation-failed'
}

function parseEvent(value: unknown): ComputerActionAuditEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sequence', 'phase', 'at', 'reason', 'resultSnapshotId']) ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !isPhase(value.phase) ||
    !isIsoDate(value.at) || (value.reason !== undefined && !isReason(value.reason)) ||
    (value.resultSnapshotId !== undefined && !isBoundedString(value.resultSnapshotId))) return undefined
  return {
    sequence: Number(value.sequence),
    phase: value.phase,
    at: value.at,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.resultSnapshotId === undefined ? {} : { resultSnapshotId: value.resultSnapshotId }),
  }
}

function cloneTarget(target: ComputerTarget): ComputerTarget {
  return {
    ...target,
    ...(target.bounds === undefined ? {} : { bounds: { ...target.bounds } }),
  }
}

function cloneAction(action: ComputerActionSummary): ComputerActionSummary {
  if (action.kind === 'click') {
    return {
      ...action,
      target: action.target.mode === 'element'
        ? { ...action.target }
        : { ...action.target, point: { ...action.target.point } },
    }
  }
  if (action.kind === 'key') return { ...action, modifiers: [...action.modifiers] }
  if (action.kind === 'scroll') {
    return {
      ...action,
      ...(action.target === undefined ? {} : {
        target: action.target.mode === 'element'
          ? { ...action.target }
          : { ...action.target, point: { ...action.target.point } },
      }),
    }
  }
  return { ...action }
}

function cloneRecord(record: ComputerActionAuditRecord): ComputerActionAuditRecord {
  return {
    ...record,
    target: cloneTarget(record.target),
    action: cloneAction(record.action),
    events: record.events.map(event => ({ ...event })),
  }
}

function parseRecord(value: unknown): ComputerActionAuditRecord | undefined {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ['actionId', 'sessionId', 'sourceSnapshotId', 'target', 'action', 'events']) ||
    !isActionId(value.actionId) || !isBoundedString(value.sessionId) ||
    !isBoundedString(value.sourceSnapshotId) || !Array.isArray(value.events) ||
    value.events.length < 1 || value.events.length > 16) return undefined
  const target = parseComputerTarget(value.target)
  const action = parseComputerActionSummary(value.action)
  const events = value.events.map(parseEvent)
  if (target === undefined || action === undefined || events.some(event => event === undefined)) return undefined
  if (events[0]!.phase !== 'intent') return undefined
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence ||
      !canTransition(events[index - 1]!.phase, events[index]!.phase)) return undefined
  }
  for (const event of events as ComputerActionAuditEvent[]) {
    if (!isTerminal(event.phase) && (event.reason !== undefined || event.resultSnapshotId !== undefined)) {
      return undefined
    }
    if (isTerminal(event.phase) && event.reason === undefined) return undefined
    if (event.phase === 'succeeded' &&
      (event.reason !== 'completed' || event.resultSnapshotId === undefined)) return undefined
    if (event.phase === 'failed' && event.reason !== 'helper-rejected') return undefined
    if (event.phase === 'cancelled' && event.reason !== 'cancelled-before-dispatch' &&
      event.reason !== 'interrupted-before-dispatch') return undefined
    if (event.phase === 'ambiguous' && event.reason !== 'helper-result-ambiguous' &&
      event.reason !== 'interrupted-after-dispatch' && event.reason !== 'observation-failed') return undefined
    if (event.phase !== 'succeeded' && event.resultSnapshotId !== undefined) return undefined
  }
  return {
    actionId: value.actionId,
    sessionId: value.sessionId,
    sourceSnapshotId: value.sourceSnapshotId,
    target,
    action,
    events: events as ComputerActionAuditEvent[],
  }
}

function parseState(value: unknown): ComputerActionAuditState | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'nextSequence', 'actions']) ||
    value.version !== AUDIT_VERSION || !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < 1 || !Array.isArray(value.actions) ||
    value.actions.length > MAX_ACTIONS_ON_DISK) return undefined
  const actions = value.actions.map(parseRecord)
  if (actions.some(action => action === undefined)) return undefined
  const records = actions as ComputerActionAuditRecord[]
  if (new Set(records.map(action => action.actionId)).size !== records.length) return undefined
  const sequences = records.flatMap(action => action.events.map(event => event.sequence))
  if (new Set(sequences).size !== sequences.length) return undefined
  const maxSequence = Math.max(0, ...sequences)
  if (Number(value.nextSequence) <= maxSequence) return undefined
  return { version: AUDIT_VERSION, nextSequence: Number(value.nextSequence), actions: records }
}

function isTerminal(phase: ComputerActionAuditPhase): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled' || phase === 'ambiguous'
}

function canTransition(from: ComputerActionAuditPhase, to: ComputerActionAuditPhase): boolean {
  if (from === 'intent') return to === 'approved' || to === 'cancelled'
  if (from === 'approved') return to === 'dispatch' || to === 'cancelled'
  if (from === 'dispatch') {
    return to === 'succeeded' || to === 'failed' || to === 'ambiguous'
  }
  return false
}

function isOutcomePair(
  phase: Extract<ComputerActionAuditPhase, 'succeeded' | 'failed' | 'cancelled' | 'ambiguous'>,
  reason: ComputerActionAuditReason,
  resultSnapshotId?: string,
): boolean {
  if (phase === 'succeeded') return reason === 'completed' && resultSnapshotId !== undefined
  if (resultSnapshotId !== undefined) return false
  if (phase === 'failed') return reason === 'helper-rejected'
  if (phase === 'cancelled') {
    return reason === 'cancelled-before-dispatch' || reason === 'interrupted-before-dispatch'
  }
  return reason === 'helper-result-ambiguous' || reason === 'interrupted-after-dispatch' ||
    reason === 'observation-failed'
}

export class ComputerActionAuditStore {
  private state: ComputerActionAuditState = { version: AUDIT_VERSION, nextSequence: 1, actions: [] }
  private available = true
  private unavailableReason?: string
  private readonly maxActions: number
  private readonly now: () => Date

  constructor(
    private readonly path: string,
    options: ComputerActionAuditStoreOptions = {},
  ) {
    this.maxActions = Math.max(1, Math.min(options.maxActions ?? DEFAULT_MAX_ACTIONS, MAX_ACTIONS_ON_DISK))
    this.now = options.now ?? (() => new Date())
    try {
      const stored = readJsonFile(path)
      if (stored !== undefined) {
        const parsed = parseState(stored)
        if (parsed === undefined) throw new Error('invalid audit data')
        this.state = parsed
        this.recoverInterrupted()
      }
    } catch {
      this.available = false
      this.unavailableReason = 'The computer action audit log could not be loaded safely.'
    }
  }

  status(): { available: boolean; message?: string } {
    return {
      available: this.available,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  has(actionId: string): boolean {
    return this.state.actions.some(action => action.actionId === actionId)
  }

  recent(limit = 20): ComputerActionAuditRecord[] {
    const bounded = Math.max(0, Math.min(limit, 100))
    return this.state.actions.slice(-bounded).reverse().map(cloneRecord)
  }

  recordIntent(input: {
    actionId: string
    sessionId: string
    sourceSnapshotId: string
    target: ComputerTarget
    action: ComputerAction
  }): void {
    this.assertAvailable()
    if (!isActionId(input.actionId)) {
      throw new ComputerActionAuditError('DESKTOP_UNAVAILABLE', 'The computer action identifier is invalid.')
    }
    if (this.has(input.actionId)) {
      throw new ComputerActionAuditError(
        'DUPLICATE_REQUEST',
        'This computer action identifier has already been used and will not be replayed.',
      )
    }
    this.commit(next => {
      if (next.actions.length >= this.maxActions) {
        throw new ComputerActionAuditError(
          'DESKTOP_UNAVAILABLE',
          'The computer action audit log is full and must be reviewed before more actions can run.',
        )
      }
      next.actions.push({
        actionId: input.actionId,
        sessionId: input.sessionId,
        sourceSnapshotId: input.sourceSnapshotId,
        target: cloneTarget(input.target),
        action: summarizeComputerAction(input.action),
        events: [this.nextEvent(next, 'intent')],
      })
    })
  }

  recordApproval(actionId: string): void {
    this.append(actionId, 'approved')
  }

  recordDispatch(actionId: string): void {
    this.append(actionId, 'dispatch')
  }

  recordOutcome(
    actionId: string,
    phase: Extract<ComputerActionAuditPhase, 'succeeded' | 'failed' | 'cancelled' | 'ambiguous'>,
    reason: ComputerActionAuditReason,
    resultSnapshotId?: string,
  ): void {
    if (!isOutcomePair(phase, reason, resultSnapshotId)) {
      throw new ComputerActionAuditError('DESKTOP_UNAVAILABLE', 'The computer action outcome is invalid.')
    }
    this.append(actionId, phase, reason, resultSnapshotId)
  }

  private recoverInterrupted(): void {
    const interrupted = this.state.actions.filter(action => {
      const latest = action.events.at(-1)?.phase
      return latest !== undefined && !isTerminal(latest)
    })
    if (interrupted.length === 0) return
    this.commit(next => {
      for (const action of next.actions) {
        const latest = action.events.at(-1)?.phase
        if (latest === undefined || isTerminal(latest)) continue
        const dispatched = action.events.some(event => event.phase === 'dispatch')
        action.events.push(this.nextEvent(
          next,
          dispatched ? 'ambiguous' : 'cancelled',
          dispatched ? 'interrupted-after-dispatch' : 'interrupted-before-dispatch',
        ))
      }
    })
  }

  private append(
    actionId: string,
    phase: ComputerActionAuditPhase,
    reason?: ComputerActionAuditReason,
    resultSnapshotId?: string,
  ): void {
    this.assertAvailable()
    this.commit(next => {
      const action = next.actions.find(item => item.actionId === actionId)
      if (action === undefined) throw new ComputerActionAuditError('NOT_FOUND', 'The computer action was not found.')
      const latest = action.events.at(-1)?.phase
      if (latest === undefined || isTerminal(latest)) {
        throw new ComputerActionAuditError('DUPLICATE_REQUEST', 'The computer action is already complete.')
      }
      if (!canTransition(latest, phase)) {
        throw new ComputerActionAuditError('DUPLICATE_REQUEST', 'The computer action phase is already recorded.')
      }
      action.events.push(this.nextEvent(next, phase, reason, resultSnapshotId))
    })
  }

  private nextEvent(
    state: ComputerActionAuditState,
    phase: ComputerActionAuditPhase,
    reason?: ComputerActionAuditReason,
    resultSnapshotId?: string,
  ): ComputerActionAuditEvent {
    const event: ComputerActionAuditEvent = {
      sequence: state.nextSequence,
      phase,
      at: this.now().toISOString(),
      ...(reason === undefined ? {} : { reason }),
      ...(resultSnapshotId === undefined ? {} : { resultSnapshotId }),
    }
    state.nextSequence += 1
    return event
  }

  private commit(change: (next: ComputerActionAuditState) => void): void {
    this.assertAvailable()
    const next: ComputerActionAuditState = {
      version: AUDIT_VERSION,
      nextSequence: this.state.nextSequence,
      actions: this.state.actions.map(cloneRecord),
    }
    change(next)
    try {
      writeJsonAtomically(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof ComputerActionAuditError) throw error
      this.available = false
      this.unavailableReason = 'The computer action audit log could not be persisted safely.'
      throw new ComputerActionAuditError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
  }

  private assertAvailable(): void {
    if (this.available) return
    throw new ComputerActionAuditError(
      'DESKTOP_UNAVAILABLE',
      this.unavailableReason ?? 'The computer action audit log is unavailable.',
    )
  }
}
