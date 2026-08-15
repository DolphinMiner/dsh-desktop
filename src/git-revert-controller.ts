import { createHash, randomUUID } from 'node:crypto'

import type {
  DesktopGitRevertConfirmInput,
  DesktopGitRevertPreviewInput,
  DesktopProtocolError,
  GitRepositoryIdentity,
  GitRevertParams,
  GitRevertPreview,
  GitRevertResult,
  GitReviewParams,
  GitReviewSnapshot,
  GitStatusParams,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'
import { parseGitReviewPatch } from '@dolphinminer/dsh-desktop-protocol'

import { GitRepositoryMutationQueue } from './git-index-controller'
import { GitMutationJournal, gitMutationPhase, type GitMutationRecord } from './git-mutation-journal'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PENDING_PREVIEWS = 128

export interface GitRevertWorkspace {
  discover(
    input: DesktopGitRevertPreviewInput | DesktopGitRevertConfirmInput,
    signal: AbortSignal,
  ): Promise<GitRepositoryIdentity>
  review(input: GitReviewParams, signal: AbortSignal): Promise<GitReviewSnapshot>
  status(input: GitStatusParams, signal: AbortSignal): Promise<GitStatusSnapshot>
  revertWorktree(input: GitRevertParams, signal: AbortSignal): Promise<GitStatusSnapshot>
}

export interface GitRevertControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
  approve?: (details: { path: string; repositoryRoot: string }) => Promise<boolean>
}

interface PendingGitRevertPreview {
  previewId: string
  sessionId: string
  workspaceRoot: string
  repository: GitRepositoryIdentity
  path: string
  fingerprint: string
  expiresAt: string
}

export class GitRevertControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'GitRevertControllerError'
  }
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function reviewFingerprint(review: GitReviewSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    repository: review.repository,
    scope: review.scope,
    head: review.head,
    files: review.files,
    patch: review.patch,
  })).digest('hex')
}

function assertRevertibleReview(review: GitReviewSnapshot, path: string): void {
  if (review.scope.kind !== 'unstaged') {
    throw new GitRevertControllerError('BAD_MESSAGE', 'Only unstaged changes can be reverted from this preview.')
  }
  const matches = review.files.filter(file => file.path === path)
  if (matches.length !== 1) {
    throw new GitRevertControllerError('CONFLICT', 'The selected file is no longer in the unstaged review.')
  }
  const file = matches[0]!
  if (!file.patchAvailable || (file.status !== 'modified' && file.status !== 'deleted' &&
    file.status !== 'type-changed')) {
    throw new GitRevertControllerError(
      'BAD_MESSAGE',
      'This change cannot be reverted safely from the current review. Unstage it first or handle it in Git.',
    )
  }
  const patchMatches = parseGitReviewPatch(review.patch).filter(item => item.path === path)
  if (patchMatches.length !== 1) {
    throw new GitRevertControllerError('CONFLICT', 'The selected file patch is no longer available.')
  }
}

function duplicateMessage(record: GitMutationRecord): string {
  const phase = gitMutationPhase(record)
  if (phase === 'ambiguous' || phase === 'dispatch') {
    return 'The revert may already have changed the file. Refresh Git status before deciding what to do.'
  }
  if (phase === 'cancelled') {
    return 'The revert approval expired before dispatch and will not be replayed. Create a new preview.'
  }
  return 'This revert approval has already been completed and cannot be replayed.'
}

export class GitRevertController {
  private readonly previews = new Map<string, PendingGitRevertPreview>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number
  private readonly approve: NonNullable<GitRevertControllerOptions['approve']>

  constructor(
    private readonly git: GitRevertWorkspace,
    private readonly journal: GitMutationJournal,
    private readonly queue = new GitRepositoryMutationQueue(),
    options: GitRevertControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
    this.approve = options.approve ?? (async () => false)
  }

  async preview(input: DesktopGitRevertPreviewInput, signal: AbortSignal): Promise<GitRevertPreview> {
    if (!this.journal.status().available) {
      throw new GitRevertControllerError('DESKTOP_UNAVAILABLE', 'The Git mutation journal is unavailable.')
    }
    const repository = await this.git.discover(input, signal)
    const review = await this.git.review({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
      scope: { kind: 'unstaged' },
    }, signal)
    assertRevertibleReview(review, input.path)
    const now = this.now()
    this.pruneExpired(now)
    for (const [id, pending] of this.previews) {
      if (pending.sessionId === input.sessionId && pending.path === input.path) this.previews.delete(id)
    }
    while (this.previews.size >= MAX_PENDING_PREVIEWS) {
      const oldest = this.previews.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.previews.delete(oldest)
    }
    const previewId = this.randomId()
    if (!isUuid(previewId)) {
      throw new GitRevertControllerError('DESKTOP_UNAVAILABLE', 'A secure revert preview could not be created.')
    }
    const expiresAt = new Date(now.getTime() + this.previewTtlMs).toISOString()
    this.previews.set(previewId, {
      previewId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repository: { ...repository },
      path: input.path,
      fingerprint: reviewFingerprint(review),
      expiresAt,
    })
    return { previewId, path: input.path, expiresAt, review }
  }

  async confirm(input: DesktopGitRevertConfirmInput, signal: AbortSignal): Promise<GitRevertResult> {
    const discovered = await this.git.discover(input, signal)
    return this.queue.run(discovered.root, async () => {
      const repository = await this.git.discover(input, signal)
      if (!sameRepository(discovered, repository)) {
        throw new GitRevertControllerError('CONFLICT', 'The active workspace repository changed before the revert.')
      }
      const pending = this.previews.get(input.previewId)
      if (pending === undefined) return this.resolveDuplicate(input, repository, signal)
      if (pending.sessionId !== input.sessionId || pending.workspaceRoot !== input.workspaceRoot ||
        !sameRepository(pending.repository, repository)) {
        this.previews.delete(input.previewId)
        throw new GitRevertControllerError('BAD_MESSAGE', 'The revert preview does not belong to this workspace.')
      }
      if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
        this.previews.delete(input.previewId)
        throw new GitRevertControllerError('CONFLICT', 'The revert preview expired. Refresh and preview it again.')
      }

      const review = await this.git.review({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
        scope: { kind: 'unstaged' },
      }, signal)
      try {
        assertRevertibleReview(review, pending.path)
      } catch (error) {
        this.previews.delete(input.previewId)
        throw error
      }
      if (reviewFingerprint(review) !== pending.fingerprint) {
        this.previews.delete(input.previewId)
        throw new GitRevertControllerError(
          'CONFLICT',
          'The unstaged review changed after approval. Refresh and preview the revert again.',
        )
      }

      const approved = await this.approve({ path: pending.path, repositoryRoot: repository.root })
      if (!approved) {
        this.previews.delete(input.previewId)
        throw new GitRevertControllerError('CANCELLED', 'The revert was cancelled.')
      }
      if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
        this.previews.delete(input.previewId)
        throw new GitRevertControllerError('CONFLICT', 'The revert preview expired. Refresh and preview it again.')
      }
      const approvedReview = await this.git.review({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
        scope: { kind: 'unstaged' },
      }, signal)
      try {
        assertRevertibleReview(approvedReview, pending.path)
      } catch (error) {
        this.previews.delete(input.previewId)
        throw error
      }
      if (reviewFingerprint(approvedReview) !== pending.fingerprint) {
        this.previews.delete(input.previewId)
        throw new GitRevertControllerError(
          'CONFLICT',
          'The unstaged review changed during approval. Refresh and preview the revert again.',
        )
      }

      this.journal.begin({
        operationId: input.previewId,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
        repositoryCommonDir: repository.commonDir,
        kind: 'revert',
        requestedPaths: [pending.path],
        paths: [pending.path],
        approval: { id: pending.previewId, fingerprint: pending.fingerprint },
      })
      this.previews.delete(input.previewId)
      this.journal.recordDispatch(input.previewId)

      let status: GitStatusSnapshot
      try {
        status = await this.git.revertWorktree({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          repositoryRoot: repository.root,
          operationId: input.previewId,
          path: pending.path,
        }, signal)
      } catch {
        try {
          this.journal.recordOutcome(input.previewId, 'ambiguous', 'result-ambiguous')
        } catch {
          // A dispatched destructive operation is never safe to replay after journal failure.
        }
        throw new GitRevertControllerError(
          'CONFLICT',
          'The revert result is ambiguous. Refresh Git status; this approval will not be replayed.',
        )
      }
      try {
        this.journal.recordOutcome(input.previewId, 'succeeded', 'completed')
      } catch {
        throw new GitRevertControllerError(
          'CONFLICT',
          'Git reverted the file, but the durable outcome could not be recorded. Refresh Git status before continuing.',
        )
      }
      return { operationId: input.previewId, status }
    })
  }

  private async resolveDuplicate(
    input: DesktopGitRevertConfirmInput,
    repository: GitRepositoryIdentity,
    signal: AbortSignal,
  ): Promise<GitRevertResult> {
    const existing = this.journal.get(input.previewId)
    if (existing === undefined || existing.kind !== 'revert' || existing.approval === undefined) {
      throw new GitRevertControllerError('NOT_FOUND', 'The revert preview is missing or expired. Create a new preview.')
    }
    const duplicate = this.journal.begin({
      operationId: input.previewId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
      repositoryCommonDir: repository.commonDir,
      kind: 'revert',
      requestedPaths: existing.requestedPaths,
      paths: existing.paths,
      approval: existing.approval,
    }).record
    if (gitMutationPhase(duplicate) !== 'succeeded') {
      throw new GitRevertControllerError('DUPLICATE_REQUEST', duplicateMessage(duplicate))
    }
    const status = await this.git.status({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
    }, signal)
    return { operationId: input.previewId, status }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
