import { createHash, randomUUID } from 'node:crypto'

import type {
  DesktopProtocolError,
  DesktopWorktreeHandoffConfirmInput,
  DesktopWorktreeHandoffPreflightInput,
  WorktreeHandoffPreflight,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitRepositoryMutationQueue } from './git-index-controller'
import {
  WorktreeHandoffJournal,
  WorktreeHandoffJournalError,
  worktreeHandoffOperationPhase,
  type BeginWorktreeHandoffOperationInput,
  type WorktreeHandoffOperationRecord,
} from './worktree-handoff-journal'
import type {
  ManagedWorktreeHandoffExpectation,
  ManagedWorktreeHandoffTransferResult,
  WorktreeHandoffState,
} from './worktree-manager'
import type { WorktreeRecord } from './worktree-registry'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PENDING_PREVIEWS = 128

export interface WorktreeHandoffOperations {
  inspectHandoff(
    id: string,
    direction: DesktopWorktreeHandoffPreflightInput['direction'],
    signal: AbortSignal,
  ): Promise<WorktreeHandoffState>
  transferHandoff(
    id: string,
    expected: ManagedWorktreeHandoffExpectation,
    signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<ManagedWorktreeHandoffTransferResult>
  inspectHandoffOutcome(
    id: string,
    expected: ManagedWorktreeHandoffExpectation,
    signal: AbortSignal,
  ): Promise<'completed' | 'not-applied' | 'ambiguous'>
}

export interface WorktreeHandoffControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
  approve?: (details: {
    direction: DesktopWorktreeHandoffPreflightInput['direction']
    sourcePath: string
    destinationPath: string
    sourceTree: string
    fileCount: number
  }) => Promise<boolean>
  isSessionRunning?: (sessionId: string) => boolean
  isPathRunning?: (path: string) => boolean
}

interface PendingWorktreeHandoffPreview {
  previewId: string
  worktreeId: string
  fingerprint: string
  expiresAt: string
  state: WorktreeHandoffState
}

export class WorktreeHandoffControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'WorktreeHandoffControllerError'
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

export function worktreeHandoffFingerprint(preflight: WorktreeHandoffPreflight): string {
  return createHash('sha256').update(JSON.stringify(preflight)).digest('hex')
}

function patchFingerprint(preflight: WorktreeHandoffPreflight): string {
  return createHash('sha256').update(preflight.patch).digest('hex')
}

function expectation(preflight: WorktreeHandoffPreflight): ManagedWorktreeHandoffExpectation {
  if (!preflight.canTransfer || preflight.sourceTree === undefined || preflight.source.branch === undefined ||
    preflight.destination.branch === undefined) {
    throw new WorktreeHandoffControllerError(
      'CONFLICT',
      'This handoff is blocked. Resolve every preflight issue and inspect it again.',
    )
  }
  return {
    direction: preflight.direction,
    baseCommit: preflight.baseCommit,
    sourceTree: preflight.sourceTree,
    sourceHead: preflight.source.head,
    sourceBranch: preflight.source.branch,
    destinationBranch: preflight.destination.branch,
  }
}

function journalInput(
  operationId: string,
  fingerprint: string,
  state: WorktreeHandoffState,
): BeginWorktreeHandoffOperationInput {
  const preflight = state.preflight
  const expected = expectation(preflight)
  return {
    operationId,
    worktreeId: state.record.id,
    direction: preflight.direction,
    repositoryRoot: state.record.repository.root,
    repositoryCommonDir: state.record.repository.commonDir,
    worktreePath: state.record.worktreePath!,
    branch: state.record.branch!,
    baseCommit: expected.baseCommit,
    sourceTree: expected.sourceTree,
    source: { ...preflight.source },
    destination: { ...preflight.destination },
    files: preflight.files.map(file => ({ ...file })),
    patchFingerprint: patchFingerprint(preflight),
    approvalFingerprint: fingerprint,
  }
}

function expectationFromOperation(operation: WorktreeHandoffOperationRecord): ManagedWorktreeHandoffExpectation {
  return {
    direction: operation.direction,
    baseCommit: operation.baseCommit,
    sourceTree: operation.sourceTree,
    sourceHead: operation.source.head,
    sourceBranch: operation.source.branch!,
    destinationBranch: operation.destination.branch!,
  }
}

function successfulResult(operation: WorktreeHandoffOperationRecord): WorktreeHandoffResult {
  return {
    operationId: operation.operationId,
    direction: operation.direction,
    sourceTree: operation.sourceTree,
  }
}

function mapJournalError(error: unknown): never {
  if (error instanceof WorktreeHandoffControllerError) throw error
  if (error instanceof WorktreeHandoffJournalError) {
    throw new WorktreeHandoffControllerError(error.code, error.message)
  }
  throw error
}

export class WorktreeHandoffController {
  private readonly previews = new Map<string, PendingWorktreeHandoffPreview>()
  private readonly inFlight = new Map<string, Promise<WorktreeHandoffResult>>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number
  private readonly approve: NonNullable<WorktreeHandoffControllerOptions['approve']>
  private readonly isSessionRunning: NonNullable<WorktreeHandoffControllerOptions['isSessionRunning']>
  private readonly isPathRunning: NonNullable<WorktreeHandoffControllerOptions['isPathRunning']>

  constructor(
    private readonly worktrees: WorktreeHandoffOperations,
    private readonly journal: WorktreeHandoffJournal,
    private readonly queue = new GitRepositoryMutationQueue(),
    options: WorktreeHandoffControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
    this.approve = options.approve ?? (async () => false)
    this.isSessionRunning = options.isSessionRunning ?? (() => false)
    this.isPathRunning = options.isPathRunning ?? (() => false)
  }

  async preview(
    input: DesktopWorktreeHandoffPreflightInput,
    signal: AbortSignal,
  ): Promise<WorktreeHandoffPreview> {
    if (!this.journal.status().available) {
      throw new WorktreeHandoffControllerError('DESKTOP_UNAVAILABLE', 'The worktree handoff journal is unavailable.')
    }
    const state = await this.worktrees.inspectHandoff(input.worktreeId, input.direction, signal)
    this.assertInactive(state.preflight)
    const now = this.now()
    this.pruneExpired(now)
    for (const [id, pending] of this.previews) {
      if (pending.worktreeId === input.worktreeId) this.previews.delete(id)
    }
    while (this.previews.size >= MAX_PENDING_PREVIEWS) {
      const oldest = this.previews.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.previews.delete(oldest)
    }
    const previewId = this.randomId()
    if (!isUuid(previewId) || this.previews.has(previewId)) {
      throw new WorktreeHandoffControllerError(
        'DESKTOP_UNAVAILABLE',
        'A secure worktree handoff preview could not be created.',
      )
    }
    const expiresAt = new Date(now.getTime() + this.previewTtlMs).toISOString()
    this.previews.set(previewId, {
      previewId,
      worktreeId: input.worktreeId,
      fingerprint: worktreeHandoffFingerprint(state.preflight),
      expiresAt,
      state,
    })
    return { previewId, expiresAt, preflight: state.preflight }
  }

  async confirm(
    input: DesktopWorktreeHandoffConfirmInput,
    signal: AbortSignal,
  ): Promise<WorktreeHandoffResult> {
    const running = this.inFlight.get(input.previewId)
    if (running !== undefined) return running
    const initial = this.previews.get(input.previewId)
    if (initial === undefined) return this.resolveDuplicate(input.previewId)
    const operation = this.queue.run(initial.state.record.repository.root, async () => {
      const pending = this.previews.get(input.previewId)
      if (pending === undefined) return this.resolveDuplicate(input.previewId)
      this.assertFresh(pending, 'expired. Inspect the handoff again.')

      const beforeApproval = await this.worktrees.inspectHandoff(
        pending.worktreeId,
        pending.state.preflight.direction,
        signal,
      )
      this.assertInactive(beforeApproval.preflight)
      expectation(beforeApproval.preflight)
      if (worktreeHandoffFingerprint(beforeApproval.preflight) !== pending.fingerprint) {
        this.previews.delete(input.previewId)
        throw new WorktreeHandoffControllerError(
          'CONFLICT',
          'The handoff changed after preview. Inspect it again before transfer.',
        )
      }

      const approved = await this.approve({
        direction: beforeApproval.preflight.direction,
        sourcePath: beforeApproval.preflight.source.path,
        destinationPath: beforeApproval.preflight.destination.path,
        sourceTree: beforeApproval.preflight.sourceTree!,
        fileCount: beforeApproval.preflight.files.length,
      })
      if (!approved) {
        this.previews.delete(input.previewId)
        throw new WorktreeHandoffControllerError('CANCELLED', 'The worktree handoff was cancelled.')
      }
      this.assertFresh(pending, 'expired during approval. Inspect the handoff again.')

      const afterApproval = await this.worktrees.inspectHandoff(
        pending.worktreeId,
        pending.state.preflight.direction,
        signal,
      )
      this.assertInactive(afterApproval.preflight)
      const expected = expectation(afterApproval.preflight)
      if (worktreeHandoffFingerprint(afterApproval.preflight) !== pending.fingerprint) {
        this.previews.delete(input.previewId)
        throw new WorktreeHandoffControllerError(
          'CONFLICT',
          'The handoff changed during approval. Inspect it again before transfer.',
        )
      }

      let begun: ReturnType<WorktreeHandoffJournal['begin']>
      try {
        begun = this.journal.begin(journalInput(input.previewId, pending.fingerprint, afterApproval))
      } catch (error) {
        mapJournalError(error)
      }
      if (!begun!.created) {
        this.previews.delete(input.previewId)
        return this.resolveOperation(begun!.operation)
      }
      this.previews.delete(input.previewId)

      let transferred: ManagedWorktreeHandoffTransferResult
      try {
        transferred = await this.worktrees.transferHandoff(
          pending.worktreeId,
          expected,
          signal,
          () => {
            this.assertInactive(afterApproval.preflight)
            try {
              this.journal.recordDispatch(input.previewId)
            } catch (error) {
              mapJournalError(error)
            }
          },
        )
      } catch (error) {
        return this.resolveTransferFailure(input.previewId, error)
      }

      try {
        this.journal.recordOutcome(input.previewId, 'succeeded', 'completed')
      } catch (error) {
        if (error instanceof WorktreeHandoffJournalError) {
          throw new WorktreeHandoffControllerError(
            'CONFLICT',
            'Git completed the handoff, but its durable outcome could not be recorded. Refresh Git before continuing.',
          )
        }
        throw error
      }
      return {
        operationId: input.previewId,
        direction: expected.direction,
        sourceTree: transferred.result.sourceTree,
      }
    })
    this.inFlight.set(input.previewId, operation)
    try {
      return await operation
    } finally {
      if (this.inFlight.get(input.previewId) === operation) this.inFlight.delete(input.previewId)
    }
  }

  private async resolveDuplicate(operationId: string): Promise<WorktreeHandoffResult> {
    let operation: WorktreeHandoffOperationRecord | undefined
    try {
      operation = this.journal.get(operationId)
    } catch (error) {
      mapJournalError(error)
    }
    if (operation === undefined) {
      throw new WorktreeHandoffControllerError(
        'NOT_FOUND',
        'The worktree handoff preview is missing or expired. Create a new preview.',
      )
    }
    return this.resolveOperation(operation)
  }

  private async resolveOperation(operation: WorktreeHandoffOperationRecord): Promise<WorktreeHandoffResult> {
    const phase = worktreeHandoffOperationPhase(operation)
    if (phase === 'succeeded') return successfulResult(operation)
    if (phase === 'ambiguous') return this.reconcile(operation)
    if (phase === 'dispatch') {
      throw new WorktreeHandoffControllerError(
        'DUPLICATE_REQUEST',
        'This handoff is still running and cannot be dispatched again.',
      )
    }
    if (phase === 'failed') {
      throw new WorktreeHandoffControllerError(
        'DUPLICATE_REQUEST',
        'This handoff was not applied and will not be replayed. Create a new preview.',
      )
    }
    throw new WorktreeHandoffControllerError(
      'DUPLICATE_REQUEST',
      'This handoff stopped before dispatch and will not be replayed. Create a new preview.',
    )
  }

  private async resolveTransferFailure(operationId: string, originalError: unknown): Promise<WorktreeHandoffResult> {
    let operation: WorktreeHandoffOperationRecord
    try {
      operation = this.journal.get(operationId)!
    } catch (error) {
      mapJournalError(error)
    }
    const phase = worktreeHandoffOperationPhase(operation!)
    if (phase === 'intent') {
      try {
        this.journal.recordCancellation(operationId)
      } catch (error) {
        mapJournalError(error)
      }
      throw originalError
    }
    if (phase === 'dispatch' || phase === 'ambiguous') return this.reconcile(operation!)
    return this.resolveOperation(operation!)
  }

  private async reconcile(operation: WorktreeHandoffOperationRecord): Promise<WorktreeHandoffResult> {
    let outcome: 'completed' | 'not-applied' | 'ambiguous'
    try {
      outcome = await this.worktrees.inspectHandoffOutcome(
        operation.worktreeId,
        expectationFromOperation(operation),
        new AbortController().signal,
      )
    } catch {
      outcome = 'ambiguous'
    }
    const phase = worktreeHandoffOperationPhase(operation)
    if (outcome === 'completed') {
      try {
        if (phase === 'dispatch') this.journal.recordOutcome(operation.operationId, 'succeeded', 'completed')
        else this.journal.recordOutcome(operation.operationId, 'succeeded', 'reconciled-completed')
      } catch (error) {
        mapJournalError(error)
      }
      return successfulResult(operation)
    }
    if (outcome === 'not-applied') {
      try {
        if (phase === 'dispatch') this.journal.recordOutcome(operation.operationId, 'failed', 'not-applied')
        else this.journal.recordOutcome(operation.operationId, 'failed', 'reconciled-not-applied')
      } catch (error) {
        mapJournalError(error)
      }
      throw new WorktreeHandoffControllerError(
        'CONFLICT',
        'The handoff was not applied. Its approval will not be replayed; create a new preview.',
      )
    }
    if (phase === 'dispatch') {
      try {
        this.journal.recordOutcome(operation.operationId, 'ambiguous', 'result-ambiguous')
      } catch {
        // Dispatch is durable, so a failed ambiguity write never makes replay safe.
      }
    }
    throw new WorktreeHandoffControllerError(
      'CONFLICT',
      'The handoff result is ambiguous. Inspect both checkouts; this approval will not be replayed.',
    )
  }

  private assertFresh(pending: PendingWorktreeHandoffPreview, detail: string): void {
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      this.previews.delete(pending.previewId)
      throw new WorktreeHandoffControllerError('CONFLICT', `The worktree handoff preview ${detail}`)
    }
  }

  private assertInactive(preflight: WorktreeHandoffPreflight): void {
    if ((preflight.worktree.sessionId !== undefined && this.isSessionRunning(preflight.worktree.sessionId)) ||
      this.isPathRunning(preflight.source.path) || this.isPathRunning(preflight.destination.path)) {
      throw new WorktreeHandoffControllerError(
        'CONFLICT',
        'Stop active Harness sessions in both checkouts before transferring changes.',
      )
    }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
