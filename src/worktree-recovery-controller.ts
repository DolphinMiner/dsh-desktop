import { createHash, randomUUID } from 'node:crypto'

import type {
  DesktopProtocolError,
  DesktopWorktreeRecoveryConfirmInput,
  DesktopWorktreeRecoveryPreviewInput,
  WorktreeCleanupInspection,
  WorktreeRecoveryPreview,
  WorktreeRecoveryResult,
} from '@dolphinminer/dsh-desktop-protocol'

import type { InterruptedRemovalRecoveryState } from './worktree-manager'
import { summarizeWorktreeRecord, type WorktreeRecord } from './worktree-registry'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PENDING_PREVIEWS = 128

export interface WorktreeRecoveryOperations {
  inspectInterruptedRemoval(id: string, signal: AbortSignal): Promise<InterruptedRemovalRecoveryState>
  keepInterruptedRemoval(
    id: string,
    removalOperationId: string,
    expected: WorktreeCleanupInspection,
    signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord>
}

export interface WorktreeRecoveryControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
  approve?: (details: {
    repositoryRoot: string
    worktreePath: string
    branch: string
    head: string
    clean: boolean
    changeCount: number
  }) => Promise<boolean>
  isSessionRunning?: (sessionId: string) => boolean
}

interface PendingRecoveryPreview {
  previewId: string
  worktreeId: string
  removalOperationId: string
  fingerprint: string
  inspection: WorktreeCleanupInspection
  expiresAt: string
}

export class WorktreeRecoveryControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'WorktreeRecoveryControllerError'
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function recoveryFingerprint(state: InterruptedRemovalRecoveryState): string {
  return createHash('sha256').update(JSON.stringify({
    worktree: summarizeWorktreeRecord(state.record),
    repository: state.record.repository,
    creationOperationId: state.record.creationOperationId,
    removalOperationId: state.removalOperationId,
    inspection: state.inspection,
  })).digest('hex')
}

export class WorktreeRecoveryController {
  private readonly previews = new Map<string, PendingRecoveryPreview>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number
  private readonly approve: NonNullable<WorktreeRecoveryControllerOptions['approve']>
  private readonly isSessionRunning: NonNullable<WorktreeRecoveryControllerOptions['isSessionRunning']>

  constructor(
    private readonly worktrees: WorktreeRecoveryOperations,
    options: WorktreeRecoveryControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
    this.approve = options.approve ?? (async () => false)
    this.isSessionRunning = options.isSessionRunning ?? (() => false)
  }

  async preview(
    input: DesktopWorktreeRecoveryPreviewInput,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryPreview> {
    const state = await this.worktrees.inspectInterruptedRemoval(input.worktreeId, signal)
    this.assertInactive(state.record)
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
      throw new WorktreeRecoveryControllerError(
        'DESKTOP_UNAVAILABLE',
        'A secure worktree recovery preview could not be created.',
      )
    }
    const expiresAt = new Date(now.getTime() + this.previewTtlMs).toISOString()
    this.previews.set(previewId, {
      previewId,
      worktreeId: input.worktreeId,
      removalOperationId: state.removalOperationId,
      fingerprint: recoveryFingerprint(state),
      inspection: state.inspection,
      expiresAt,
    })
    return {
      previewId,
      expiresAt,
      action: 'keep-interrupted-removal',
      worktree: summarizeWorktreeRecord(state.record),
      inspection: state.inspection,
    }
  }

  async confirm(
    input: DesktopWorktreeRecoveryConfirmInput,
    signal: AbortSignal,
  ): Promise<WorktreeRecoveryResult> {
    const pending = this.previews.get(input.previewId)
    if (pending === undefined) {
      throw new WorktreeRecoveryControllerError(
        'NOT_FOUND',
        'The worktree recovery preview is missing or expired. Inspect the worktree again.',
      )
    }
    this.previews.delete(input.previewId)
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The worktree recovery preview expired. Inspect the worktree again.',
      )
    }

    const beforeApproval = await this.worktrees.inspectInterruptedRemoval(pending.worktreeId, signal)
    this.assertInactive(beforeApproval.record)
    if (recoveryFingerprint(beforeApproval) !== pending.fingerprint) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The interrupted cleanup changed after preview. Inspect it again.',
      )
    }
    const approved = await this.approve({
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
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'The worktree recovery preview expired during approval. Inspect it again.',
      )
    }

    const afterApproval = await this.worktrees.inspectInterruptedRemoval(pending.worktreeId, signal)
    this.assertInactive(afterApproval.record)
    if (recoveryFingerprint(afterApproval) !== pending.fingerprint) {
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
      resolutionId: input.previewId,
      action: 'keep-interrupted-removal',
      worktree: summarizeWorktreeRecord(kept),
    }
  }

  private assertInactive(record: WorktreeRecord): void {
    if (record.sessionId !== undefined && this.isSessionRunning(record.sessionId)) {
      throw new WorktreeRecoveryControllerError(
        'CONFLICT',
        'Stop the active Harness session before resolving this interrupted cleanup.',
      )
    }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
