import { createHash, randomUUID } from 'node:crypto'

import type {
  DesktopProtocolError,
  DesktopWorktreeRecoveryConfirmInput,
  DesktopWorktreeRecoveryPreviewInput,
  MissingWorktreeRecoveryInspection,
  MovedWorktreeRecoveryInspection,
  WorktreeCleanupInspection,
  WorktreeRecoveryPreview,
  WorktreeRecoveryResult,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitRepositoryMutationQueue } from './git-index-controller'
import type {
  InterruptedRemovalRecoveryState,
  MissingWorktreeRecoveryState,
  MovedWorktreeRecoveryState,
} from './worktree-manager'
import { summarizeWorktreeRecord, type WorktreeRecord } from './worktree-registry'
import {
  WorktreeRelocationJournal,
  WorktreeRelocationJournalError,
  worktreeRelocationPhase,
  type WorktreeRelocationRecord,
} from './worktree-relocation-journal'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PENDING_PREVIEWS = 128

export interface WorktreeRecoveryOperations {
  get(id: string): WorktreeRecord | undefined
  inspectInterruptedRemoval(id: string, signal: AbortSignal): Promise<InterruptedRemovalRecoveryState>
  keepInterruptedRemoval(
    id: string,
    removalOperationId: string,
    expected: WorktreeCleanupInspection,
    signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord>
  inspectMissingWorktree(id: string, signal: AbortSignal): Promise<MissingWorktreeRecoveryState>
  forgetMissingWorktree(
    id: string,
    resolutionOperationId: string,
    expected: MissingWorktreeRecoveryInspection,
    signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord>
  inspectMovedWorktree(id: string, signal: AbortSignal): Promise<MovedWorktreeRecoveryState>
  restoreMovedWorktree(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord>
  inspectMovedWorktreeOutcome(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    signal: AbortSignal,
  ): Promise<'completed' | 'not-applied' | 'ambiguous'>
  completeMovedWorktreeRecovery(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    signal: AbortSignal,
  ): Promise<WorktreeRecord>
}

export interface WorktreeRecoveryControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
  relocationJournal?: WorktreeRelocationJournal
  mutationQueue?: GitRepositoryMutationQueue
  approve?: (details: {
    action: 'keep-interrupted-removal'
    repositoryRoot: string
    worktreePath: string
    branch: string
    head: string
    clean: boolean
    changeCount: number
  } | {
    action: 'forget-missing'
    repositoryRoot: string
    worktreePath: string
    branch: string
  } | {
    action: 'restore-moved'
    repositoryRoot: string
    currentPath: string
    registeredPath: string
    branch: string
    head: string
    clean: boolean
    changeCount: number
  }) => Promise<boolean>
  isSessionRunning?: (sessionId: string) => boolean
}

interface PendingRecoveryPreviewBase {
  previewId: string
  worktreeId: string
  fingerprint: string
  expiresAt: string
}

interface PendingInterruptedRemovalPreview extends PendingRecoveryPreviewBase {
  action: 'keep-interrupted-removal'
  removalOperationId: string
  inspection: WorktreeCleanupInspection
}

interface PendingMissingWorktreePreview extends PendingRecoveryPreviewBase {
  action: 'forget-missing'
  inspection: MissingWorktreeRecoveryInspection
}

interface PendingMovedWorktreePreview extends PendingRecoveryPreviewBase {
  action: 'restore-moved'
  state: MovedWorktreeRecoveryState
}

type PendingRecoveryPreview =
  | PendingInterruptedRemovalPreview
  | PendingMissingWorktreePreview
  | PendingMovedWorktreePreview

export class WorktreeRecoveryControllerError extends Error {
  constructor(
    readonly code: DesktopProtocolError['code'],
    message: string,
    readonly ambiguous = false,
  ) {
    super(message)
    this.name = 'WorktreeRecoveryControllerError'
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function interruptedRemovalFingerprint(state: InterruptedRemovalRecoveryState): string {
  return createHash('sha256').update(JSON.stringify({
    worktree: summarizeWorktreeRecord(state.record),
    repository: state.record.repository,
    creationOperationId: state.record.creationOperationId,
    removalOperationId: state.removalOperationId,
    inspection: state.inspection,
  })).digest('hex')
}

function missingWorktreeFingerprint(state: MissingWorktreeRecoveryState): string {
  return createHash('sha256').update(JSON.stringify({
    worktree: summarizeWorktreeRecord(state.record),
    repository: state.record.repository,
    creationOperationId: state.record.creationOperationId,
    inspection: state.inspection,
  })).digest('hex')
}

function movedWorktreeFingerprint(state: MovedWorktreeRecoveryState): string {
  return createHash('sha256').update(JSON.stringify({
    worktree: summarizeWorktreeRecord(state.record),
    repository: state.record.repository,
    creationOperationId: state.record.creationOperationId,
    inspection: state.inspection,
  })).digest('hex')
}

function mapRelocationJournalError(error: unknown): never {
  if (error instanceof WorktreeRecoveryControllerError) throw error
  if (error instanceof WorktreeRelocationJournalError) {
    throw new WorktreeRecoveryControllerError(error.code, error.message)
  }
  throw error
}

function recordMatchesRelocation(
  record: WorktreeRecord | undefined,
  operation: WorktreeRelocationRecord,
): record is WorktreeRecord {
  return record !== undefined && record.executionMode === 'worktree' &&
    record.repository.root === operation.repository.root &&
    record.repository.gitDir === operation.repository.gitDir &&
    record.repository.commonDir === operation.repository.commonDir &&
    record.worktreePath === operation.inspection.registeredPath &&
    record.branch === operation.inspection.current.branch
}

export class WorktreeRecoveryController {
  private readonly previews = new Map<string, PendingRecoveryPreview>()
  private readonly inFlight = new Map<string, Promise<WorktreeRecoveryResult>>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number
  private readonly approve: NonNullable<WorktreeRecoveryControllerOptions['approve']>
  private readonly isSessionRunning: NonNullable<WorktreeRecoveryControllerOptions['isSessionRunning']>
  private readonly relocations?: WorktreeRelocationJournal
  private readonly mutationQueue: GitRepositoryMutationQueue

  constructor(
    private readonly worktrees: WorktreeRecoveryOperations,
    options: WorktreeRecoveryControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
    this.approve = options.approve ?? (async () => false)
    this.isSessionRunning = options.isSessionRunning ?? (() => false)
    this.relocations = options.relocationJournal
    this.mutationQueue = options.mutationQueue ?? new GitRepositoryMutationQueue()
  }

  async preview(
    input: DesktopWorktreeRecoveryPreviewInput,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryPreview> {
    if (input.action === 'keep-interrupted-removal') {
      const state = await this.worktrees.inspectInterruptedRemoval(input.worktreeId, signal)
      this.assertInactive(state.record)
      const identity = this.createPreviewIdentity(input.worktreeId)
      this.previews.set(identity.previewId, {
        ...identity,
        worktreeId: input.worktreeId,
        action: input.action,
        removalOperationId: state.removalOperationId,
        fingerprint: interruptedRemovalFingerprint(state),
        inspection: state.inspection,
      })
      return {
        ...identity,
        action: input.action,
        worktree: summarizeWorktreeRecord(state.record),
        inspection: state.inspection,
      }
    }
    if (input.action === 'forget-missing') {
      const state = await this.worktrees.inspectMissingWorktree(input.worktreeId, signal)
      this.assertInactive(state.record)
      const identity = this.createPreviewIdentity(input.worktreeId)
      this.previews.set(identity.previewId, {
        ...identity,
        worktreeId: input.worktreeId,
        action: input.action,
        fingerprint: missingWorktreeFingerprint(state),
        inspection: state.inspection,
      })
      return {
        ...identity,
        action: input.action,
        worktree: summarizeWorktreeRecord(state.record),
        inspection: state.inspection,
      }
    }
    if (this.relocations === undefined) {
      throw new WorktreeRecoveryControllerError(
        'DESKTOP_UNAVAILABLE',
        'Durable moved-worktree recovery is unavailable.',
      )
    }
    const state = await this.worktrees.inspectMovedWorktree(input.worktreeId, signal)
    this.assertInactive(state.record)
    const identity = this.createPreviewIdentity(input.worktreeId)
    this.previews.set(identity.previewId, {
      ...identity,
      worktreeId: input.worktreeId,
      action: input.action,
      fingerprint: movedWorktreeFingerprint(state),
      state,
    })
    return {
      ...identity,
      action: input.action,
      worktree: summarizeWorktreeRecord(state.record),
      inspection: state.inspection,
    }
  }

  async confirm(
    input: DesktopWorktreeRecoveryConfirmInput,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    const running = this.inFlight.get(input.previewId)
    if (running !== undefined) return running
    const pending = this.previews.get(input.previewId)
    if (pending === undefined) {
      return this.resolveDuplicate(input.previewId, signal)
    }
    this.previews.delete(input.previewId)
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The worktree recovery preview expired. Inspect the worktree again.',
      )
    }

    if (pending.action === 'keep-interrupted-removal') {
      return this.confirmInterruptedRemoval(input.previewId, pending, signal)
    }
    if (pending.action === 'forget-missing') {
      return this.confirmMissingWorktree(input.previewId, pending, signal)
    }
    const operation = this.mutationQueue.run(pending.state.record.repository.root, () =>
      this.confirmMovedWorktree(input.previewId, pending, signal))
    this.inFlight.set(input.previewId, operation)
    try {
      return await operation
    } finally {
      if (this.inFlight.get(input.previewId) === operation) this.inFlight.delete(input.previewId)
    }
  }

  private async confirmInterruptedRemoval(
    resolutionId: string,
    pending: PendingInterruptedRemovalPreview,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    const beforeApproval = await this.worktrees.inspectInterruptedRemoval(pending.worktreeId, signal)
    this.assertInactive(beforeApproval.record)
    if (interruptedRemovalFingerprint(beforeApproval) !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The interrupted cleanup changed after preview. Inspect it again.',
      )
    }
    const approved = await this.approve({
      action: pending.action,
      repositoryRoot: beforeApproval.record.repository.root,
      worktreePath: beforeApproval.inspection.worktreePath,
      branch: beforeApproval.inspection.branch,
      head: beforeApproval.inspection.head,
      clean: beforeApproval.inspection.clean,
      changeCount: beforeApproval.inspection.changes.length,
    })
    if (!approved) {
      throw new WorktreeRecoveryControllerError('CANCELLED', 'The worktree recovery was cancelled.')
    }
    this.assertNotExpiredAfterApproval(pending)

    const afterApproval = await this.worktrees.inspectInterruptedRemoval(pending.worktreeId, signal)
    this.assertInactive(afterApproval.record)
    if (interruptedRemovalFingerprint(afterApproval) !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The interrupted cleanup changed during approval. Inspect it again.',
      )
    }
    const kept = await this.worktrees.keepInterruptedRemoval(
      pending.worktreeId,
      pending.removalOperationId,
      pending.inspection,
      signal,
      record => this.assertInactive(record),
    )
    return {
      resolutionId,
      action: pending.action,
      worktree: summarizeWorktreeRecord(kept),
    }
  }

  private async confirmMissingWorktree(
    resolutionId: string,
    pending: PendingMissingWorktreePreview,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    const beforeApproval = await this.worktrees.inspectMissingWorktree(pending.worktreeId, signal)
    this.assertInactive(beforeApproval.record)
    if (missingWorktreeFingerprint(beforeApproval) !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The missing checkout changed after preview. Inspect it again.',
      )
    }
    const approved = await this.approve({
      action: pending.action,
      repositoryRoot: beforeApproval.record.repository.root,
      worktreePath: beforeApproval.inspection.worktreePath,
      branch: beforeApproval.inspection.branch,
    })
    if (!approved) {
      throw new WorktreeRecoveryControllerError('CANCELLED', 'The missing-worktree recovery was cancelled.')
    }
    this.assertNotExpiredAfterApproval(pending)

    const afterApproval = await this.worktrees.inspectMissingWorktree(pending.worktreeId, signal)
    this.assertInactive(afterApproval.record)
    if (missingWorktreeFingerprint(afterApproval) !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The missing checkout changed during approval. Inspect it again.',
      )
    }
    const forgotten = await this.worktrees.forgetMissingWorktree(
      pending.worktreeId,
      resolutionId,
      pending.inspection,
      signal,
      record => this.assertInactive(record),
    )
    return {
      resolutionId,
      action: pending.action,
      worktree: summarizeWorktreeRecord(forgotten),
    }
  }

  private async confirmMovedWorktree(
    resolutionId: string,
    pending: PendingMovedWorktreePreview,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    const beforeApproval = await this.worktrees.inspectMovedWorktree(pending.worktreeId, signal)
    this.assertInactive(beforeApproval.record)
    if (movedWorktreeFingerprint(beforeApproval) !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The moved checkout changed after preview. Inspect it again.',
      )
    }
    const approved = await this.approve({
      action: 'restore-moved',
      repositoryRoot: beforeApproval.record.repository.root,
      currentPath: beforeApproval.inspection.current.worktreePath,
      registeredPath: beforeApproval.inspection.registeredPath,
      branch: beforeApproval.inspection.current.branch,
      head: beforeApproval.inspection.current.head,
      clean: beforeApproval.inspection.current.clean,
      changeCount: beforeApproval.inspection.current.changes.length,
    })
    if (!approved) {
      throw new WorktreeRecoveryControllerError('CANCELLED', 'The moved-worktree recovery was cancelled.')
    }
    this.assertNotExpiredAfterApproval(pending)

    const afterApproval = await this.worktrees.inspectMovedWorktree(pending.worktreeId, signal)
    this.assertInactive(afterApproval.record)
    const fingerprint = movedWorktreeFingerprint(afterApproval)
    if (fingerprint !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The moved checkout changed during approval. Inspect it again.',
      )
    }

    let begun: ReturnType<WorktreeRelocationJournal['begin']>
    try {
      begun = this.relocations!.begin({
        operationId: resolutionId,
        worktreeId: pending.worktreeId,
        repository: afterApproval.record.repository,
        inspection: afterApproval.inspection,
        fingerprint,
      })
    } catch (error) {
      mapRelocationJournalError(error)
    }
    if (!begun!.created) return this.resolveMovedOperation(begun!.operation, signal)

    let restored: WorktreeRecord
    try {
      restored = await this.worktrees.restoreMovedWorktree(
        pending.worktreeId,
        afterApproval.inspection,
        signal,
        record => {
          this.assertInactive(record)
          try {
            this.relocations!.recordDispatch(resolutionId)
          } catch (error) {
            mapRelocationJournalError(error)
          }
        },
      )
    } catch (error) {
      return this.resolveMovedFailure(resolutionId, error, signal)
    }

    try {
      this.relocations!.recordOutcome(resolutionId, 'succeeded', 'completed')
    } catch (error) {
      if (error instanceof WorktreeRelocationJournalError) {
        throw new WorktreeRecoveryControllerError(
          'CONFLICT',
          'Git restored the checkout, but its durable outcome could not be recorded. Restart, then recheck Worktrees.',
          true,
        )
      }
      throw error
    }
    return { resolutionId, action: 'restore-moved', worktree: summarizeWorktreeRecord(restored) }
  }

  private async resolveDuplicate(
    resolutionId: string,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    let operation: WorktreeRelocationRecord | undefined
    try {
      operation = this.relocations?.get(resolutionId)
    } catch (error) {
      mapRelocationJournalError(error)
    }
    if (operation === undefined) {
      throw new WorktreeRecoveryControllerError(
        'NOT_FOUND',
        'The worktree recovery preview is missing or expired. Inspect the worktree again.',
      )
    }
    return this.mutationQueue.run(operation.repository.root, async () => {
      let current: WorktreeRelocationRecord | undefined
      try {
        current = this.relocations!.get(resolutionId)
      } catch (error) {
        mapRelocationJournalError(error)
      }
      if (current === undefined) {
        throw new WorktreeRecoveryControllerError('NOT_FOUND', 'The worktree relocation operation was not found.')
      }
      return this.resolveMovedOperation(current, signal)
    })
  }

  private async resolveMovedFailure(
    resolutionId: string,
    originalError: unknown,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    let operation: WorktreeRelocationRecord | undefined
    try {
      operation = this.relocations!.get(resolutionId)
    } catch (error) {
      mapRelocationJournalError(error)
    }
    if (operation === undefined) throw originalError
    const phase = worktreeRelocationPhase(operation)
    if (phase === 'intent') {
      try {
        this.relocations!.recordCancellation(resolutionId)
      } catch (error) {
        mapRelocationJournalError(error)
      }
      throw originalError
    }
    if (phase === 'dispatch' || phase === 'ambiguous') {
      return this.reconcileMovedOperation(operation, signal)
    }
    return this.resolveMovedOperation(operation, signal)
  }

  private async resolveMovedOperation(
    operation: WorktreeRelocationRecord,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    const phase = worktreeRelocationPhase(operation)
    if (phase === 'succeeded') {
      const record = this.worktrees.get(operation.worktreeId)
      if (!recordMatchesRelocation(record, operation) ||
        (record.lifecycle !== 'ready' && record.lifecycle !== 'orphaned')) {
        throw new WorktreeRecoveryControllerError(
          'CONFLICT',
          'The restored checkout result no longer matches the worktree registry.',
          true,
        )
      }
      return {
        resolutionId: operation.operationId,
        action: 'restore-moved',
        worktree: summarizeWorktreeRecord(record),
      }
    }
    if (phase === 'ambiguous' || phase === 'dispatch') return this.reconcileMovedOperation(operation, signal)
    const detail = phase === 'failed'
      ? 'was not applied'
      : 'stopped before dispatch'
    throw new WorktreeRecoveryControllerError(
      'DUPLICATE_REQUEST',
      `This moved-worktree recovery ${detail} and will not be replayed. Create a new preview.`,
    )
  }

  private async reconcileMovedOperation(
    operation: WorktreeRelocationRecord,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    let outcome: 'completed' | 'not-applied' | 'ambiguous'
    const phase = worktreeRelocationPhase(operation)
    const currentRecord = this.worktrees.get(operation.worktreeId)
    if (!recordMatchesRelocation(currentRecord, operation)) {
      this.recordAmbiguousAfterDispatch(operation)
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The managed repository identity changed after relocation approval.',
        true,
      )
    }
    try {
      outcome = await this.worktrees.inspectMovedWorktreeOutcome(
        operation.worktreeId,
        operation.inspection,
        signal,
      )
    } catch {
      outcome = 'ambiguous'
    }
    if (outcome === 'completed') {
      let record: WorktreeRecord
      try {
        record = await this.worktrees.completeMovedWorktreeRecovery(
          operation.worktreeId,
          operation.inspection,
          signal,
        )
      } catch (error) {
        this.recordAmbiguousAfterDispatch(operation)
        throw error
      }
      try {
        this.relocations!.recordOutcome(
          operation.operationId,
          'succeeded',
          phase === 'dispatch' ? 'completed' : 'reconciled-completed',
        )
      } catch (error) {
        if (error instanceof WorktreeRelocationJournalError) {
          throw new WorktreeRecoveryControllerError(
            'CONFLICT',
            'The checkout is restored, but its durable relocation outcome could not be recorded. Restart, then recheck Worktrees.',
            true,
          )
        }
        throw error
      }
      return {
        resolutionId: operation.operationId,
        action: 'restore-moved',
        worktree: summarizeWorktreeRecord(record),
      }
    }
    if (outcome === 'not-applied') {
      try {
        this.relocations!.recordOutcome(
          operation.operationId,
          'failed',
          phase === 'dispatch' ? 'not-applied' : 'reconciled-not-applied',
        )
      } catch (error) {
        mapRelocationJournalError(error)
      }
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The checkout was not moved. Its approval will not be replayed; create a new preview.',
      )
    }
    this.recordAmbiguousAfterDispatch(operation)
    throw new WorktreeRecoveryControllerError(
      'CONFLICT',
      'The moved-worktree recovery result is ambiguous. Inspect both paths; this approval will not be replayed.',
      true,
    )
  }

  private recordAmbiguousAfterDispatch(operation: WorktreeRelocationRecord): void {
    if (worktreeRelocationPhase(operation) !== 'dispatch') return
    try {
      this.relocations!.recordOutcome(operation.operationId, 'ambiguous', 'result-ambiguous')
    } catch {
      // A durable dispatch is never made replayable by a failed ambiguity update.
    }
  }

  async reconcileRelocations(signal: AbortSignal): Promise<void> {
    if (this.relocations === undefined) return
    let operations: WorktreeRelocationRecord[]
    try {
      operations = this.relocations.list()
    } catch (error) {
      mapRelocationJournalError(error)
    }
    for (const operation of operations!) {
      if (worktreeRelocationPhase(operation) !== 'ambiguous') continue
      try {
        await this.mutationQueue.run(operation.repository.root, () =>
          this.reconcileMovedOperation(operation, signal))
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
  }

  private createPreviewIdentity(worktreeId: string): { previewId: string; expiresAt: string } {
    const now = this.now()
    this.pruneExpired(now)
    for (const [id, pending] of this.previews) {
      if (pending.worktreeId === worktreeId) this.previews.delete(id)
    }
    while (this.previews.size >= MAX_PENDING_PREVIEWS) {
      const oldest = this.previews.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.previews.delete(oldest)
    }
    const previewId = this.randomId()
    if (!isUuid(previewId) || this.previews.has(previewId)) {
      throw new WorktreeRecoveryControllerError(
        'DESKTOP_UNAVAILABLE',
        'A secure worktree recovery preview could not be created.',
      )
    }
    return { previewId, expiresAt: new Date(now.getTime() + this.previewTtlMs).toISOString() }
  }

  private assertNotExpiredAfterApproval(pending: PendingRecoveryPreview): void {
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The worktree recovery preview expired during approval. Inspect it again.',
      )
    }
  }

  private assertInactive(record: WorktreeRecord): void {
    if (record.sessionId !== undefined && this.isSessionRunning(record.sessionId)) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'Stop the active Harness session before resolving this worktree recovery.',
      )
    }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
