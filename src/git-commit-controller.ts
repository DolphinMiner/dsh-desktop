import { randomUUID } from 'node:crypto'

import type {
  DesktopGitCommitConfirmInput,
  DesktopGitCommitPreviewInput,
  DesktopProtocolError,
  GitCommitParams,
  GitCommitPreview,
  GitCommitResult,
  GitRepositoryIdentity,
  GitReviewParams,
  GitReviewSnapshot,
  GitStatusParams,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitRepositoryMutationQueue } from './git-index-controller'
import { GitMutationJournal, gitMutationPhase, type GitMutationRecord } from './git-mutation-journal'
import { gitReviewFingerprint } from './git-review-fingerprint'

const DEFAULT_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PREVIEW_TTL_MS = 15 * 60_000
const MAX_PENDING_PREVIEWS = 64
const MAX_RECORDED_PATHS = 256

export interface GitCommitWorkspace {
  discover(
    input: DesktopGitCommitPreviewInput | DesktopGitCommitConfirmInput,
    signal: AbortSignal,
  ): Promise<GitRepositoryIdentity>
  review(input: GitReviewParams, signal: AbortSignal): Promise<GitReviewSnapshot>
  status(input: GitStatusParams, signal: AbortSignal): Promise<GitStatusSnapshot>
  indexTree(input: GitStatusParams, signal: AbortSignal): Promise<string>
  commit(input: GitCommitParams, signal: AbortSignal): Promise<GitCommitResult>
}

export interface GitCommitControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
}

interface PendingGitCommitPreview {
  previewId: string
  sessionId: string
  workspaceRoot: string
  repository: GitRepositoryIdentity
  expectedHead?: string
  expectedTree: string
  stagedFingerprint: string
  paths: string[]
  expiresAt: string
}

interface StagedCommitState {
  review: GitReviewSnapshot
  tree: string
  fingerprint: string
  paths: string[]
}

export class GitCommitControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'GitCommitControllerError'
  }
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isConflictError(error: unknown): error is Error & { code: 'CONFLICT' } {
  return error instanceof Error && 'code' in error && error.code === 'CONFLICT'
}

function stagedPaths(review: GitReviewSnapshot): string[] {
  if (review.scope.kind !== 'staged' || review.files.length === 0) {
    throw new GitCommitControllerError('CONFLICT', 'There are no staged changes to commit.')
  }
  if (review.files.some(file => !file.patchAvailable || file.status === 'unmerged' || file.status === 'untracked')) {
    throw new GitCommitControllerError('CONFLICT', 'Resolve staged conflicts before creating a commit.')
  }
  const paths = new Set<string>()
  for (const file of review.files) {
    if (file.originalPath !== undefined) paths.add(file.originalPath)
    paths.add(file.path)
  }
  if (paths.size > MAX_RECORDED_PATHS) {
    throw new GitCommitControllerError(
      'CONFLICT',
      `This commit contains more than ${String(MAX_RECORDED_PATHS)} paths. Commit it with Git for now.`,
    )
  }
  return [...paths]
}

function duplicateMessage(record: GitMutationRecord): string {
  const phase = gitMutationPhase(record)
  if (phase === 'ambiguous' || phase === 'dispatch') {
    return 'The commit may already exist. Refresh Git history before deciding what to do.'
  }
  if (phase === 'failed') {
    return 'Git rejected this commit. Review the current staged changes and create a new commit preview.'
  }
  if (phase === 'cancelled') {
    return 'The commit stopped before dispatch and will not be replayed. Create a new preview.'
  }
  return 'This commit preview has already been completed and cannot be replayed.'
}

export class GitCommitController {
  private readonly previews = new Map<string, PendingGitCommitPreview>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number

  constructor(
    private readonly git: GitCommitWorkspace,
    private readonly journal: GitMutationJournal,
    private readonly queue = new GitRepositoryMutationQueue(),
    options: GitCommitControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
  }

  async preview(input: DesktopGitCommitPreviewInput, signal: AbortSignal): Promise<GitCommitPreview> {
    if (!this.journal.status().available) {
      throw new GitCommitControllerError('DESKTOP_UNAVAILABLE', 'The Git mutation journal is unavailable.')
    }
    const discovered = await this.git.discover(input, signal)
    return this.queue.run(discovered.root, async () => {
      const repository = await this.git.discover(input, signal)
      if (!sameRepository(discovered, repository)) {
        throw new GitCommitControllerError('CONFLICT', 'The active workspace repository changed before preview.')
      }
      const state = await this.readStagedState(input, repository, signal)
      const now = this.now()
      this.pruneExpired(now)
      for (const [id, pending] of this.previews) {
        if (pending.sessionId === input.sessionId && pending.workspaceRoot === input.workspaceRoot) {
          this.previews.delete(id)
        }
      }
      while (this.previews.size >= MAX_PENDING_PREVIEWS) {
        const oldest = this.previews.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.previews.delete(oldest)
      }
      const previewId = this.randomId()
      if (!isUuid(previewId)) {
        throw new GitCommitControllerError('DESKTOP_UNAVAILABLE', 'A secure commit preview could not be created.')
      }
      const expiresAt = new Date(now.getTime() + this.previewTtlMs).toISOString()
      this.previews.set(previewId, {
        previewId,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repository: { ...repository },
        ...(state.review.head === undefined ? {} : { expectedHead: state.review.head }),
        expectedTree: state.tree,
        stagedFingerprint: state.fingerprint,
        paths: [...state.paths],
        expiresAt,
      })
      return { previewId, expiresAt, review: state.review }
    })
  }

  async confirm(input: DesktopGitCommitConfirmInput, signal: AbortSignal): Promise<GitCommitResult> {
    const discovered = await this.git.discover(input, signal)
    return this.queue.run(discovered.root, async () => {
      const repository = await this.git.discover(input, signal)
      if (!sameRepository(discovered, repository)) {
        throw new GitCommitControllerError('CONFLICT', 'The active workspace repository changed before commit.')
      }
      const pending = this.previews.get(input.previewId)
      if (pending === undefined) return this.resolveDuplicate(input, repository, signal)
      if (pending.sessionId !== input.sessionId || pending.workspaceRoot !== input.workspaceRoot ||
        !sameRepository(pending.repository, repository)) {
        this.previews.delete(input.previewId)
        throw new GitCommitControllerError('BAD_MESSAGE', 'The commit preview does not belong to this workspace.')
      }
      if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
        this.previews.delete(input.previewId)
        throw new GitCommitControllerError('CONFLICT', 'The commit preview expired. Refresh and preview it again.')
      }
      const state = await this.readStagedState(input, repository, signal)
      if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
        this.previews.delete(input.previewId)
        throw new GitCommitControllerError('CONFLICT', 'The commit preview expired. Refresh and preview it again.')
      }
      if (state.review.head !== pending.expectedHead || state.tree !== pending.expectedTree ||
        state.fingerprint !== pending.stagedFingerprint) {
        this.previews.delete(input.previewId)
        throw new GitCommitControllerError(
          'CONFLICT',
          'The staged changes changed after preview. Refresh and review them before committing.',
        )
      }

      this.journal.begin({
        operationId: input.previewId,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
        repositoryCommonDir: repository.commonDir,
        kind: 'commit',
        requestedPaths: pending.paths,
        paths: pending.paths,
        commit: {
          message: input.message,
          ...(pending.expectedHead === undefined ? {} : { expectedHead: pending.expectedHead }),
          expectedTree: pending.expectedTree,
          stagedFingerprint: pending.stagedFingerprint,
        },
      })
      this.previews.delete(input.previewId)
      this.journal.recordDispatch(input.previewId)

      let result: GitCommitResult
      try {
        result = await this.git.commit({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          repositoryRoot: repository.root,
          operationId: input.previewId,
          message: input.message,
          ...(pending.expectedHead === undefined ? {} : { expectedHead: pending.expectedHead }),
          expectedTree: pending.expectedTree,
        }, signal)
      } catch (error) {
        await this.throwIfRejectedCommit(input, repository, pending.expectedHead, error, signal)
        try {
          this.journal.recordOutcome(input.previewId, 'ambiguous', 'result-ambiguous')
        } catch {
          // A dispatched commit is never replayed when either Git or durable state is uncertain.
        }
        throw new GitCommitControllerError(
          'CONFLICT',
          'The commit result is ambiguous. Refresh Git history; this preview will not be replayed.',
        )
      }
      try {
        this.journal.recordOutcome(input.previewId, 'succeeded', 'completed', result.commit)
      } catch {
        throw new GitCommitControllerError(
          'CONFLICT',
          `Git created commit ${result.commit}, but the durable outcome could not be recorded. Refresh Git history.`,
        )
      }
      return result
    })
  }

  private async readStagedState(
    input: DesktopGitCommitPreviewInput | DesktopGitCommitConfirmInput,
    repository: GitRepositoryIdentity,
    signal: AbortSignal,
  ): Promise<StagedCommitState> {
    const params = {
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
    }
    const treeBefore = await this.git.indexTree(params, signal)
    const review = await this.git.review({ ...params, scope: { kind: 'staged' } }, signal)
    const treeAfter = await this.git.indexTree(params, signal)
    if (treeBefore !== treeAfter) {
      throw new GitCommitControllerError('CONFLICT', 'The Git index changed while creating the commit preview.')
    }
    return {
      review,
      tree: treeAfter,
      fingerprint: gitReviewFingerprint(review),
      paths: stagedPaths(review),
    }
  }

  private async throwIfRejectedCommit(
    input: DesktopGitCommitConfirmInput,
    repository: GitRepositoryIdentity,
    expectedHead: string | undefined,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isConflictError(error)) return
    let status: GitStatusSnapshot
    try {
      status = await this.git.status({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
      }, signal)
    } catch {
      return
    }
    if (!sameRepository(status.repository, repository) || status.head !== expectedHead) return
    try {
      this.journal.recordOutcome(input.previewId, 'failed', 'git-rejected')
    } catch {
      throw new GitCommitControllerError(
        'CONFLICT',
        'Git did not create a commit, but the durable outcome could not be recorded. Create a new preview.',
      )
    }
    throw new GitCommitControllerError('CONFLICT', error.message)
  }

  private async resolveDuplicate(
    input: DesktopGitCommitConfirmInput,
    repository: GitRepositoryIdentity,
    signal: AbortSignal,
  ): Promise<GitCommitResult> {
    const existing = this.journal.get(input.previewId)
    if (existing === undefined || existing.kind !== 'commit' || existing.commit === undefined) {
      throw new GitCommitControllerError('NOT_FOUND', 'The commit preview is missing or expired. Create a new preview.')
    }
    const duplicate = this.journal.begin({
      operationId: input.previewId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
      repositoryCommonDir: repository.commonDir,
      kind: 'commit',
      requestedPaths: existing.requestedPaths,
      paths: existing.paths,
      commit: { ...existing.commit, message: input.message },
    }).record
    if (gitMutationPhase(duplicate) !== 'succeeded' || duplicate.resultCommit === undefined) {
      throw new GitCommitControllerError('DUPLICATE_REQUEST', duplicateMessage(duplicate))
    }
    const status = await this.git.status({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
    }, signal)
    if (status.head !== duplicate.resultCommit) {
      throw new GitCommitControllerError(
        'DUPLICATE_REQUEST',
        `This preview already created commit ${duplicate.resultCommit}, but HEAD has since advanced.`,
      )
    }
    return { operationId: input.previewId, commit: duplicate.resultCommit, status }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
