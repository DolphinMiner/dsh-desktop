import { isAbsolute, normalize } from 'node:path'

import {
  parseGitRepositoryIdentity,
  parseGitTurnBoundaryParams,
  type GitRepositoryIdentity,
  type GitTurnEndBoundaryParams,
  type GitTurnStartBoundaryParams,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const GIT_TURN_ATTRIBUTION_SCHEMA_VERSION = 1 as const
const MAX_RECORDS = 10_000
const MAX_PATH_LENGTH = 4_096

export type GitTurnAttributionState =
  | 'capturing-start'
  | 'started'
  | 'capturing-end'
  | 'captured'
  | 'not-completed'
  | 'unavailable'

export type GitTurnAttributionUnavailableReason =
  | 'capture-failed'
  | 'repository-changed'
  | 'interrupted'
  | 'missing-start'

export interface GitTurnAttributionRecord {
  sessionId: string
  workspaceRoot: string
  turn: number
  state: GitTurnAttributionState
  startEventSeq?: number
  startEventTime?: number
  repository?: GitRepositoryIdentity
  startTree?: string
  endEventSeq?: number
  endEventTime?: number
  endReason?: GitTurnEndBoundaryParams['reason']
  endTree?: string
  unavailableReason?: GitTurnAttributionUnavailableReason
  updatedAt: string
}

interface GitTurnAttributionDocument {
  schemaVersion: typeof GIT_TURN_ATTRIBUTION_SCHEMA_VERSION
  revision: number
  records: GitTurnAttributionRecord[]
}

export interface GitTurnAttributionJournalOptions {
  now?: () => Date
  maxRecords?: number
  write?: typeof writeJsonAtomically
}

export class GitTurnAttributionJournalError extends Error {
  constructor(
    readonly code: 'BAD_MESSAGE' | 'CONFLICT' | 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'GitTurnAttributionJournalError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') && isAbsolute(value) && normalize(value) === value
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isEventNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

function isState(value: unknown): value is GitTurnAttributionState {
  return value === 'capturing-start' || value === 'started' || value === 'capturing-end' ||
    value === 'captured' || value === 'not-completed' || value === 'unavailable'
}

function isUnavailableReason(value: unknown): value is GitTurnAttributionUnavailableReason {
  return value === 'capture-failed' || value === 'repository-changed' || value === 'interrupted' ||
    value === 'missing-start'
}

function parseStoredRecord(value: unknown): GitTurnAttributionRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'turn', 'state', 'startEventSeq', 'startEventTime', 'repository', 'startTree',
    'endEventSeq', 'endEventTime', 'endReason', 'endTree', 'unavailableReason', 'updatedAt',
  ]) || typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 256 ||
    value.sessionId.includes('\0') || !isCanonicalAbsolutePath(value.workspaceRoot) ||
    !isEventNumber(value.turn) || !isState(value.state) || !isIsoDate(value.updatedAt)) return undefined

  const hasStart = value.startEventSeq !== undefined || value.startEventTime !== undefined
  if (hasStart && (!isEventNumber(value.startEventSeq) || !isEventNumber(value.startEventTime))) return undefined
  const repository = value.repository === undefined ? undefined : parseGitRepositoryIdentity(value.repository)
  const hasRepository = value.repository !== undefined || value.startTree !== undefined
  if (hasRepository && (repository === undefined || !isCanonicalAbsolutePath(repository.root) ||
    !isCanonicalAbsolutePath(repository.gitDir) || !isCanonicalAbsolutePath(repository.commonDir) ||
    !isObjectId(value.startTree) || !hasStart)) return undefined
  const hasEnd = value.endEventSeq !== undefined || value.endEventTime !== undefined || value.endReason !== undefined
  const parsedBoundary = hasEnd ? parseGitTurnBoundaryParams({
    sessionId: value.sessionId,
    workspaceRoot: value.workspaceRoot,
    turn: value.turn,
    eventSeq: value.endEventSeq,
    eventTime: value.endEventTime,
    boundary: 'end',
    reason: value.endReason,
  }) : undefined
  const parsedEnd = parsedBoundary?.boundary === 'end' ? parsedBoundary : undefined
  if (hasEnd && parsedEnd === undefined) return undefined
  if (hasStart && hasEnd && (Number(value.endEventSeq) <= Number(value.startEventSeq) ||
    Number(value.endEventTime) < Number(value.startEventTime))) return undefined
  const hasEndTree = value.endTree !== undefined
  if (hasEndTree && !isObjectId(value.endTree)) return undefined
  const unavailableReason = value.unavailableReason === undefined
    ? undefined
    : isUnavailableReason(value.unavailableReason) ? value.unavailableReason : undefined
  if (value.unavailableReason !== undefined && unavailableReason === undefined) return undefined

  if (value.state === 'capturing-start' && (!hasStart || hasRepository || hasEnd || hasEndTree ||
    unavailableReason !== undefined)) return undefined
  if (value.state === 'started' && (!hasStart || !hasRepository || hasEnd || hasEndTree ||
    unavailableReason !== undefined)) return undefined
  if (value.state === 'capturing-end' && (!hasStart || !hasRepository || !hasEnd ||
    parsedEnd?.reason !== 'completed' || hasEndTree || unavailableReason !== undefined)) return undefined
  if (value.state === 'captured' && (!hasStart || !hasRepository || !hasEnd ||
    parsedEnd?.reason !== 'completed' || !hasEndTree || unavailableReason !== undefined)) return undefined
  if (value.state === 'not-completed' && (!hasEnd || parsedEnd?.reason === 'completed' || hasEndTree ||
    unavailableReason !== undefined || (hasRepository && !hasStart))) return undefined
  if (value.state === 'unavailable' && (hasEndTree || unavailableReason === undefined ||
    (hasRepository && !hasStart))) return undefined

  return {
    sessionId: value.sessionId,
    workspaceRoot: value.workspaceRoot,
    turn: Number(value.turn),
    state: value.state,
    ...(hasStart ? {
      startEventSeq: Number(value.startEventSeq),
      startEventTime: Number(value.startEventTime),
    } : {}),
    ...(repository === undefined ? {} : { repository, startTree: value.startTree as string }),
    ...(parsedEnd === undefined ? {} : {
      endEventSeq: parsedEnd.eventSeq,
      endEventTime: parsedEnd.eventTime,
      endReason: parsedEnd.reason,
    }),
    ...(value.endTree === undefined ? {} : { endTree: value.endTree as string }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    updatedAt: value.updatedAt,
  }
}

function emptyDocument(): GitTurnAttributionDocument {
  return { schemaVersion: GIT_TURN_ATTRIBUTION_SCHEMA_VERSION, revision: 0, records: [] }
}

function parseDocument(value: unknown): GitTurnAttributionDocument {
  if (value === undefined) return emptyDocument()
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'records']) ||
    value.schemaVersion !== GIT_TURN_ATTRIBUTION_SCHEMA_VERSION || !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    throw new Error('The Git turn attribution journal uses an unsupported or invalid document shape.')
  }
  const records = value.records.map(parseStoredRecord)
  if (records.some(record => record === undefined)) {
    throw new Error('The Git turn attribution journal contains an invalid record.')
  }
  const parsed = records as GitTurnAttributionRecord[]
  const keys = parsed.map(record => `${record.sessionId}\0${String(record.turn)}`)
  if (new Set(keys).size !== keys.length) {
    throw new Error('The Git turn attribution journal contains duplicate turn records.')
  }
  return {
    schemaVersion: GIT_TURN_ATTRIBUTION_SCHEMA_VERSION,
    revision: Number(value.revision),
    records: parsed,
  }
}

function cloneRecord(record: GitTurnAttributionRecord): GitTurnAttributionRecord {
  return {
    ...record,
    ...(record.repository === undefined ? {} : { repository: { ...record.repository } }),
  }
}

function isTerminal(state: GitTurnAttributionState): boolean {
  return state === 'captured' || state === 'not-completed' || state === 'unavailable'
}

function sameStart(record: GitTurnAttributionRecord, input: GitTurnStartBoundaryParams): boolean {
  return record.sessionId === input.sessionId && record.workspaceRoot === input.workspaceRoot &&
    record.turn === input.turn && record.startEventSeq === input.eventSeq &&
    record.startEventTime === input.eventTime
}

function sameEnd(record: GitTurnAttributionRecord, input: GitTurnEndBoundaryParams): boolean {
  return record.sessionId === input.sessionId && record.workspaceRoot === input.workspaceRoot &&
    record.turn === input.turn && record.endEventSeq === input.eventSeq &&
    record.endEventTime === input.eventTime && record.endReason === input.reason
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

export class GitTurnAttributionJournal {
  private state = emptyDocument()
  private available = true
  private unavailableMessage?: string
  private readonly now: () => Date
  private readonly maxRecords: number
  private readonly write: typeof writeJsonAtomically

  constructor(
    private readonly path: string,
    options: GitTurnAttributionJournalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.maxRecords = Math.max(1, Math.min(options.maxRecords ?? MAX_RECORDS, MAX_RECORDS))
    this.write = options.write ?? writeJsonAtomically
    try {
      this.state = parseDocument(readJsonFile(path))
      this.recoverInterrupted()
    } catch {
      this.available = false
      this.unavailableMessage = 'Git turn attribution could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableMessage === undefined ? {} : { message: this.unavailableMessage }),
    }
  }

  records(): GitTurnAttributionRecord[] {
    this.assertAvailable()
    return this.state.records.map(cloneRecord)
  }

  beginStart(input: GitTurnStartBoundaryParams): { capture: boolean; record: GitTurnAttributionRecord } {
    this.assertAvailable()
    if (parseGitTurnBoundaryParams(input)?.boundary !== 'start' || !isCanonicalAbsolutePath(input.workspaceRoot)) {
      throw new GitTurnAttributionJournalError('BAD_MESSAGE', 'The Git turn start boundary is invalid.')
    }
    const existing = this.find(input.sessionId, input.turn)
    if (existing !== undefined) {
      if (!sameStart(existing, input)) {
        throw new GitTurnAttributionJournalError(
          'DUPLICATE_REQUEST',
          'This session turn already has a different start boundary.',
        )
      }
      return { capture: false, record: cloneRecord(existing) }
    }
    let created: GitTurnAttributionRecord | undefined
    this.commit(next => {
      this.makeRoom(next)
      created = {
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        turn: input.turn,
        state: 'capturing-start',
        startEventSeq: input.eventSeq,
        startEventTime: input.eventTime,
        updatedAt: this.nextTime(),
      }
      next.records.push(created)
    })
    return { capture: true, record: cloneRecord(created!) }
  }

  completeStart(
    input: GitTurnStartBoundaryParams,
    repository: GitRepositoryIdentity,
    tree: string,
  ): GitTurnAttributionRecord {
    return this.update(input.sessionId, input.turn, record => {
      if (!sameStart(record, input) || record.state !== 'capturing-start') {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn start capture is no longer current.')
      }
      record.state = 'started'
      record.repository = { ...repository }
      record.startTree = tree
    })
  }

  failStart(
    input: GitTurnStartBoundaryParams,
    reason: GitTurnAttributionUnavailableReason,
  ): GitTurnAttributionRecord {
    return this.update(input.sessionId, input.turn, record => {
      if (!sameStart(record, input)) {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn start boundary changed.')
      }
      if (record.state === 'unavailable') return
      if (record.state !== 'capturing-start') {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn start is already complete.')
      }
      record.state = 'unavailable'
      record.unavailableReason = reason
    })
  }

  beginEnd(input: GitTurnEndBoundaryParams): { capture: boolean; record: GitTurnAttributionRecord } {
    this.assertAvailable()
    if (parseGitTurnBoundaryParams(input)?.boundary !== 'end' || !isCanonicalAbsolutePath(input.workspaceRoot)) {
      throw new GitTurnAttributionJournalError('BAD_MESSAGE', 'The Git turn end boundary is invalid.')
    }
    const existing = this.find(input.sessionId, input.turn)
    if (existing === undefined) {
      let created: GitTurnAttributionRecord | undefined
      this.commit(next => {
        this.makeRoom(next)
        created = {
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          turn: input.turn,
          state: input.reason === 'completed' ? 'unavailable' : 'not-completed',
          endEventSeq: input.eventSeq,
          endEventTime: input.eventTime,
          endReason: input.reason,
          ...(input.reason === 'completed' ? { unavailableReason: 'missing-start' as const } : {}),
          updatedAt: this.nextTime(),
        }
        next.records.push(created)
      })
      return { capture: false, record: cloneRecord(created!) }
    }
    if (existing.workspaceRoot !== input.workspaceRoot) {
      throw new GitTurnAttributionJournalError(
        'DUPLICATE_REQUEST',
        'This session turn already belongs to a different workspace.',
      )
    }
    if (existing.endEventSeq !== undefined) {
      if (!sameEnd(existing, input)) {
        throw new GitTurnAttributionJournalError(
          'DUPLICATE_REQUEST',
          'This session turn already has a different end boundary.',
        )
      }
      return { capture: false, record: cloneRecord(existing) }
    }
    if (existing.startEventSeq !== undefined && (input.eventSeq <= existing.startEventSeq ||
      input.eventTime < existing.startEventTime!)) {
      throw new GitTurnAttributionJournalError('BAD_MESSAGE', 'The Git turn end precedes its start boundary.')
    }
    const record = this.update(input.sessionId, input.turn, current => {
      current.endEventSeq = input.eventSeq
      current.endEventTime = input.eventTime
      current.endReason = input.reason
      if (input.reason !== 'completed') {
        current.state = 'not-completed'
        delete current.unavailableReason
        return
      }
      if (current.state === 'started') {
        current.state = 'capturing-end'
        return
      }
      if (current.state !== 'unavailable') {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn start capture is incomplete.')
      }
    })
    return { capture: record.state === 'capturing-end', record }
  }

  completeEnd(
    input: GitTurnEndBoundaryParams,
    repository: GitRepositoryIdentity,
    tree: string,
  ): GitTurnAttributionRecord {
    return this.update(input.sessionId, input.turn, record => {
      if (!sameEnd(record, input) || record.state !== 'capturing-end' || record.repository === undefined ||
        !sameRepository(record.repository, repository)) {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn end capture is no longer current.')
      }
      record.state = 'captured'
      record.endTree = tree
    })
  }

  failEnd(
    input: GitTurnEndBoundaryParams,
    reason: GitTurnAttributionUnavailableReason,
  ): GitTurnAttributionRecord {
    return this.update(input.sessionId, input.turn, record => {
      if (!sameEnd(record, input)) {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn end boundary changed.')
      }
      if (record.state === 'unavailable') return
      if (record.state !== 'capturing-end') {
        throw new GitTurnAttributionJournalError('CONFLICT', 'The Git turn end is already complete.')
      }
      record.state = 'unavailable'
      record.unavailableReason = reason
    })
  }

  latestCompleted(sessionId: string, workspaceRoot: string): GitTurnAttributionRecord | undefined {
    this.assertAvailable()
    const record = this.state.records
      .filter(candidate => candidate.sessionId === sessionId && candidate.workspaceRoot === workspaceRoot &&
        candidate.endReason === 'completed')
      .sort((left, right) => left.endEventSeq! - right.endEventSeq!)
      .at(-1)
    return record === undefined ? undefined : cloneRecord(record)
  }

  private recoverInterrupted(): void {
    if (!this.state.records.some(record => !isTerminal(record.state))) return
    this.commit(next => {
      for (const record of next.records) {
        if (isTerminal(record.state)) continue
        record.state = 'unavailable'
        record.unavailableReason = 'interrupted'
        delete record.endTree
        record.updatedAt = this.nextTime(record.updatedAt)
      }
    })
  }

  private find(sessionId: string, turn: number): GitTurnAttributionRecord | undefined {
    return this.state.records.find(record => record.sessionId === sessionId && record.turn === turn)
  }

  private update(
    sessionId: string,
    turn: number,
    change: (record: GitTurnAttributionRecord) => void,
  ): GitTurnAttributionRecord {
    this.assertAvailable()
    let result: GitTurnAttributionRecord | undefined
    this.commit(next => {
      const record = next.records.find(candidate => candidate.sessionId === sessionId && candidate.turn === turn)
      if (record === undefined) {
        throw new GitTurnAttributionJournalError('NOT_FOUND', 'The Git turn attribution record was not found.')
      }
      change(record)
      record.updatedAt = this.nextTime(record.updatedAt)
      if (parseStoredRecord(record) === undefined) {
        throw new GitTurnAttributionJournalError('BAD_MESSAGE', 'The Git turn attribution transition is invalid.')
      }
      result = cloneRecord(record)
    })
    return result!
  }

  private makeRoom(document: GitTurnAttributionDocument): void {
    while (document.records.length >= this.maxRecords) {
      const terminal = document.records.findIndex(record => isTerminal(record.state))
      if (terminal < 0) {
        throw new GitTurnAttributionJournalError(
          'DESKTOP_UNAVAILABLE',
          'The Git turn attribution journal is full of active records.',
        )
      }
      document.records.splice(terminal, 1)
    }
  }

  private commit(change: (next: GitTurnAttributionDocument) => void): void {
    this.assertAvailable()
    const next: GitTurnAttributionDocument = {
      schemaVersion: GIT_TURN_ATTRIBUTION_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      records: this.state.records.map(cloneRecord),
    }
    change(next)
    try {
      this.write(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof GitTurnAttributionJournalError) throw error
      this.available = false
      this.unavailableMessage = 'Git turn attribution could not be persisted safely.'
      throw new GitTurnAttributionJournalError('DESKTOP_UNAVAILABLE', this.unavailableMessage)
    }
  }

  private nextTime(previous?: string): string {
    const previousTime = previous === undefined ? 0 : Date.parse(previous)
    return new Date(Math.max(this.now().getTime(), previousTime)).toISOString()
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new GitTurnAttributionJournalError(
        'DESKTOP_UNAVAILABLE',
        this.unavailableMessage ?? 'Git turn attribution is unavailable.',
      )
    }
  }
}
