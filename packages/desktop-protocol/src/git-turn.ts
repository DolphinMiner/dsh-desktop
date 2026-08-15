const MAX_SESSION_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_EVENT_TIME = 8_640_000_000_000_000

export type GitTurnEndReasonKind =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'other'

interface GitTurnBoundaryBase {
  sessionId: string
  workspaceRoot: string
  turn: number
  eventSeq: number
  eventTime: number
}

export interface GitTurnStartBoundaryParams extends GitTurnBoundaryBase {
  boundary: 'start'
}

export interface GitTurnEndBoundaryParams extends GitTurnBoundaryBase {
  boundary: 'end'
  reason: GitTurnEndReasonKind
}

export type GitTurnBoundaryParams = GitTurnStartBoundaryParams | GitTurnEndBoundaryParams

export type GitTurnBoundaryState = 'started' | 'captured' | 'closed' | 'duplicate' | 'unavailable'

export interface GitTurnBoundaryResult {
  accepted: boolean
  state: GitTurnBoundaryState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isBoundaryNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isEventTime(value: unknown): value is number {
  return isBoundaryNumber(value) && Number(value) <= MAX_EVENT_TIME
}

function isEndReason(value: unknown): value is GitTurnEndReasonKind {
  return value === 'completed' || value === 'aborted' || value === 'blocked' || value === 'error' ||
    value === 'max-tokens' || value === 'interrupted' || value === 'other'
}

export function parseGitTurnBoundaryParams(value: unknown): GitTurnBoundaryParams | undefined {
  if (!isRecord(value) || !isBoundedString(value.sessionId, MAX_SESSION_ID_LENGTH) ||
    !isBoundedString(value.workspaceRoot, MAX_PATH_LENGTH) || !isBoundaryNumber(value.turn) ||
    !isBoundaryNumber(value.eventSeq) || !isEventTime(value.eventTime)) return undefined
  const base = {
    sessionId: value.sessionId,
    workspaceRoot: value.workspaceRoot,
    turn: Number(value.turn),
    eventSeq: Number(value.eventSeq),
    eventTime: Number(value.eventTime),
  }
  if (value.boundary === 'start') {
    return hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'turn', 'eventSeq', 'eventTime', 'boundary'])
      ? { ...base, boundary: 'start' }
      : undefined
  }
  if (value.boundary === 'end' && isEndReason(value.reason) &&
    hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'turn', 'eventSeq', 'eventTime', 'boundary', 'reason'])) {
    return { ...base, boundary: 'end', reason: value.reason }
  }
  return undefined
}

export function parseGitTurnBoundaryResult(value: unknown): GitTurnBoundaryResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['accepted', 'state']) || typeof value.accepted !== 'boolean' ||
    (value.state !== 'started' && value.state !== 'captured' && value.state !== 'closed' &&
      value.state !== 'duplicate' && value.state !== 'unavailable') ||
    value.accepted !== (value.state !== 'unavailable')) return undefined
  return { accepted: value.accepted, state: value.state }
}
