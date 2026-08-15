import { createHash, randomUUID } from 'node:crypto'

import type {
  DesktopProtocolError,
  DesktopWorktreeCleanupConfirmInput,
  DesktopWorktreeCleanupPreviewInput,
  WorktreeCleanupInspection,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
} from '@dolphinminer/dsh-desktop-protocol'

import type { WorktreeCleanupState } from './worktree-manager'
import { summarizeWorktreeRecord, type WorktreeRecord } from './worktree-registry'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PENDING_PREVIEWS = 128

export interface WorktreeCleanupOperations {
  inspectCleanup(id: string, signal: AbortSignal): Promise<WorktreeCleanupState>
  getByOperation(operationId: string): WorktreeRecord | undefined
  removeCleanWorktree(
    id: string,
    operationId: string,
    expected: WorktreeCleanupInspection,
    signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord>
}

export interface WorktreeCleanupControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
  approve?: (details: {
    repositoryRoot: string
    worktreePath: string
    branch: string
    head: string
  }) => Promise<boolean>
  isSessionRunning?: (sessionId: string) => boolean
}

interface PendingWorktreeCleanupPreview {
  previewId: string
  worktreeId: string
  fingerprint: string
  inspection: WorktreeCleanupInspection
  expiresAt: string
}

export class WorktreeCleanupControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'WorktreeCleanupControllerError'
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function cleanupFingerprint(state: WorktreeCleanupState): string {
  return createHash('sha256').update(JSON.stringify({
    worktree: summarizeWorktreeRecord(state.record),
    inspection: state.inspection,
  })).digest('hex')
}

export class WorktreeCleanupController {
  private readonly previews = new Map<string, PendingWorktreeCleanupPreview>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number
  private readonly approve: NonNullable<WorktreeCleanupControllerOptions['approve']>
  private readonly isSessionRunning: NonNullable<WorktreeCleanupControllerOptions['isSessionRunning']>

  constructor(
    private readonly worktrees: WorktreeCleanupOperations,
    options: WorktreeCleanupControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
    this.approve = options.approve ?? (async () => false)
    this.isSessionRunning = options.isSessionRunning ?? (() => false)
  }

  async preview(
    input: DesktopWorktreeCleanupPreviewInput,
    signal: AbortSignal,
  ): Promise<WorktreeCleanupPreview> {
    const state = await this.worktrees.inspectCleanup(input.worktreeId, signal)
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
      throw new WorktreeCleanupControllerError(
        'DESKTOP_UNAVAILABLE',
        'A secure worktree cleanup preview could not be created.',
      )
    }
    const expiresAt = new Date(now.getTime() + this.previewTtlMs).toISOString()
    this.previews.set(previewId, {
      previewId,
      worktreeId: input.worktreeId,
      fingerprint: cleanupFingerprint(state),
      inspection: { ...state.inspection },
      expiresAt,
    })
    return {
      previewId,
      expiresAt,
      worktree: summarizeWorktreeRecord(state.record),
      inspection: { ...state.inspection },
    }
  }

  async confirm(
    input: DesktopWorktreeCleanupConfirmInput,
    signal: AbortSignal,
  ): Promise<WorktreeCleanupResult> {
    const pending = this.previews.get(input.previewId)
    if (pending === undefined) return this.resolveDuplicate(input.previewId)
    this.previews.delete(input.previewId)
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      throw new WorktreeCleanupControllerError(
        'CONFLICT',
        'The worktree cleanup preview expired. Inspect the worktree again.',
      )
    }

    const beforeApproval = await this.worktrees.inspectCleanup(pending.worktreeId, signal)
    this.assertInactive(beforeApproval.record)
    if (cleanupFingerprint(beforeApproval) !== pending.fingerprint) {
      throw new WorktreeCleanupControllerError(
        'CONFLICT',
        'The worktree changed after preview. Inspect it again before cleanup.',
      )
    }
    const approved = await this.approve({
      repositoryRoot: beforeApproval.record.repository.root,
      worktreePath: beforeApproval.inspection.worktreePath,
      branch: beforeApproval.inspection.branch,
      head: beforeApproval.inspection.head,
    })
    if (!approved) {
      throw new WorktreeCleanupControllerError('CANCELLED', 'The worktree cleanup was cancelled.')
    }
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      throw new WorktreeCleanupControllerError(
        'CONFLICT',
        'The worktree cleanup preview expired during approval. Inspect it again.',
      )
    }

    const afterApproval = await this.worktrees.inspectCleanup(pending.worktreeId, signal)
    this.assertInactive(afterApproval.record)
    if (cleanupFingerprint(afterApproval) !== pending.fingerprint) {
      throw new WorktreeCleanupControllerError(
        'CONFLICT',
        'The worktree changed during approval. Inspect it again before cleanup.',
      )
    }
    const removed = await this.worktrees.removeCleanWorktree(
      pending.worktreeId,
      input.previewId,
      pending.inspection,
      signal,
      record => this.assertInactive(record),
    )
    return { operationId: input.previewId, worktree: summarizeWorktreeRecord(removed) }
  }

  private resolveDuplicate(operationId: string): WorktreeCleanupResult {
    const record = this.worktrees.getByOperation(operationId)
    if (record === undefined) {
      throw new WorktreeCleanupControllerError(
        'NOT_FOUND',
        'The worktree cleanup preview is missing or expired. Create a new preview.',
      )
    }
    if (record.lifecycle === 'removed' && record.removalOperationId === operationId) {
      return { operationId, worktree: summarizeWorktreeRecord(record) }
    }
    throw new WorktreeCleanupControllerError(
      'DUPLICATE_REQUEST',
      'This worktree cleanup may already have run and will not be replayed. Refresh Worktrees to reconcile it.',
    )
  }

  private assertInactive(record: WorktreeRecord): void {
    if (record.sessionId !== undefined && this.isSessionRunning(record.sessionId)) {
      throw new WorktreeCleanupControllerError(
        'CONFLICT',
        'Stop the active Harness session before cleaning up its worktree.',
      )
    }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
