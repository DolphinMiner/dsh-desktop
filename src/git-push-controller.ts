import { createHash, randomUUID } from 'node:crypto'

import type {
  DesktopGitPushConfirmInput,
  DesktopGitPushPreviewInput,
  DesktopProtocolError,
  GitPushParams,
  GitPushPreview,
  GitPushResult,
  GitPushState,
  GitPushTarget,
  GitRepositoryIdentity,
  GitStatusParams,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitRepositoryMutationQueue } from './git-index-controller'
import { GitMutationJournal, gitMutationPhase, type GitMutationRecord } from './git-mutation-journal'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEW_TTL_MS = 10 * 60_000
const MAX_PENDING_PREVIEWS = 64

export interface GitPushWorkspace {
  discover(
    input: DesktopGitPushPreviewInput | DesktopGitPushConfirmInput,
    signal: AbortSignal,
  ): Promise<GitRepositoryIdentity>
  pushTarget(input: GitStatusParams, signal: AbortSignal): Promise<GitPushState>
  push(input: GitPushParams, signal: AbortSignal): Promise<GitPushResult>
}

export interface GitPushControllerOptions {
  now?: () => Date
  randomId?: () => string
  previewTtlMs?: number
  approve?: (details: { repositoryRoot: string; target: GitPushTarget }) => Promise<boolean>
}

interface PendingGitPushPreview {
  previewId: string
  sessionId: string
  workspaceRoot: string
  repository: GitRepositoryIdentity
  target: GitPushState
  fingerprint: string
  expiresAt: string
}

export class GitPushControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'GitPushControllerError'
  }
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function samePushState(left: GitPushState, right: GitPushState): boolean {
  return left.remote === right.remote && left.remoteUrl === right.remoteUrl &&
    left.remoteUrlFingerprint === right.remoteUrlFingerprint && left.localBranch === right.localBranch &&
    left.localRef === right.localRef && left.remoteRef === right.remoteRef &&
    left.trackingRef === right.trackingRef && left.head === right.head &&
    left.upstreamHead === right.upstreamHead && left.ahead === right.ahead && left.behind === right.behind
}

function samePushDestination(left: GitPushState, right: GitPushState): boolean {
  return left.remote === right.remote && left.remoteUrlFingerprint === right.remoteUrlFingerprint &&
    left.remoteRef === right.remoteRef
}

function publicTarget(target: GitPushState): GitPushTarget {
  const { remoteUrlFingerprint: _remoteUrlFingerprint, ...visible } = target
  return visible
}

function targetFingerprint(target: GitPushState): string {
  return createHash('sha256').update(JSON.stringify([
    target.remote,
    target.remoteUrl,
    target.remoteUrlFingerprint,
    target.localBranch,
    target.localRef,
    target.remoteRef,
    target.trackingRef,
    target.head,
    target.upstreamHead,
    target.ahead,
    target.behind,
  ])).digest('hex')
}

function assertPushable(target: GitPushState): void {
  if (target.behind !== 0) {
    throw new GitPushControllerError(
      'CONFLICT',
      'The remote branch is ahead. Fetch and reconcile it before pushing.',
    )
  }
  if (target.ahead < 1 || target.head === target.upstreamHead) {
    throw new GitPushControllerError('CONFLICT', 'There are no local commits to push.')
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function duplicateMessage(record: GitMutationRecord): string {
  const phase = gitMutationPhase(record)
  if (phase === 'ambiguous' || phase === 'dispatch') {
    return 'The push may already have reached the remote. Refresh the remote state before deciding what to do.'
  }
  if (phase === 'failed') {
    return 'Git rejected this push. Create a new preview after reviewing the current remote state.'
  }
  if (phase === 'cancelled') {
    return 'The push stopped before dispatch and will not be replayed. Create a new preview.'
  }
  return 'This push approval has already been completed and cannot be replayed.'
}

export class GitPushController {
  private readonly previews = new Map<string, PendingGitPushPreview>()
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly previewTtlMs: number
  private readonly approve: NonNullable<GitPushControllerOptions['approve']>

  constructor(
    private readonly git: GitPushWorkspace,
    private readonly journal: GitMutationJournal,
    private readonly queue = new GitRepositoryMutationQueue(),
    options: GitPushControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.previewTtlMs = Math.max(1_000, Math.min(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS))
    this.approve = options.approve ?? (async () => false)
  }

  async preview(input: DesktopGitPushPreviewInput, signal: AbortSignal): Promise<GitPushPreview> {
    if (!this.journal.status().available) {
      throw new GitPushControllerError('DESKTOP_UNAVAILABLE', 'The Git mutation journal is unavailable.')
    }
    const discovered = await this.git.discover(input, signal)
    return this.queue.run(discovered.root, async () => {
      const repository = await this.git.discover(input, signal)
      if (!sameRepository(discovered, repository)) {
        throw new GitPushControllerError('CONFLICT', 'The active workspace repository changed before Push preview.')
      }
      const target = await this.readTarget(input, repository, signal)
      assertPushable(target)
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
        throw new GitPushControllerError('DESKTOP_UNAVAILABLE', 'A secure Push preview could not be created.')
      }
      const expiresAt = new Date(now.getTime() + this.previewTtlMs).toISOString()
      this.previews.set(previewId, {
        previewId,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repository: { ...repository },
        target: { ...target },
        fingerprint: targetFingerprint(target),
        expiresAt,
      })
      return { previewId, expiresAt, target: publicTarget(target) }
    })
  }

  async confirm(input: DesktopGitPushConfirmInput, signal: AbortSignal): Promise<GitPushResult> {
    const discovered = await this.git.discover(input, signal)
    return this.queue.run(discovered.root, async () => {
      const repository = await this.git.discover(input, signal)
      if (!sameRepository(discovered, repository)) {
        throw new GitPushControllerError('CONFLICT', 'The active workspace repository changed before Push.')
      }
      const pending = this.previews.get(input.previewId)
      if (pending === undefined) return this.resolveDuplicate(input, repository)
      if (pending.sessionId !== input.sessionId || pending.workspaceRoot !== input.workspaceRoot ||
        !sameRepository(pending.repository, repository)) {
        this.previews.delete(input.previewId)
        throw new GitPushControllerError('BAD_MESSAGE', 'The Push preview does not belong to this workspace.')
      }
      this.assertNotExpired(pending, 'The Push preview expired. Refresh and preview it again.')
      const beforeApproval = await this.readTarget(input, repository, signal)
      if (!samePushState(beforeApproval, pending.target)) {
        this.previews.delete(input.previewId)
        throw new GitPushControllerError(
          'CONFLICT',
          'The local branch, upstream, or push URL changed after preview. Refresh and review it again.',
        )
      }

      const approved = await this.approve({ repositoryRoot: repository.root, target: publicTarget(pending.target) })
      if (!approved) {
        this.previews.delete(input.previewId)
        throw new GitPushControllerError('CANCELLED', 'The Push was cancelled.')
      }
      this.assertNotExpired(pending, 'The Push preview expired during approval. Refresh and preview it again.')
      const afterApproval = await this.readTarget(input, repository, signal)
      if (!samePushState(afterApproval, pending.target)) {
        this.previews.delete(input.previewId)
        throw new GitPushControllerError(
          'CONFLICT',
          'The local branch, upstream, or push URL changed during approval. Refresh and review it again.',
        )
      }

      this.journal.begin({
        operationId: input.previewId,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
        repositoryCommonDir: repository.commonDir,
        kind: 'push',
        requestedPaths: [pending.target.localRef],
        paths: [pending.target.remoteRef],
        approval: { id: pending.previewId, fingerprint: pending.fingerprint },
        push: pending.target,
      })
      this.previews.delete(input.previewId)
      this.journal.recordDispatch(input.previewId)

      let result: GitPushResult
      try {
        result = await this.git.push({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          repositoryRoot: repository.root,
          operationId: input.previewId,
          target: pending.target,
        }, signal)
      } catch (error) {
        return this.reconcileAfterError(input, repository, pending, error)
      }
      if (result.operationId !== input.previewId || result.remote !== pending.target.remote ||
        result.remoteRef !== pending.target.remoteRef || result.head !== pending.target.head) {
        this.recordAmbiguous(input.previewId)
        throw new GitPushControllerError(
          'CONFLICT',
          'Git returned an unexpected Push result. Refresh the remote state; this approval will not be replayed.',
        )
      }
      this.recordSuccess(input.previewId, result.head)
      return result
    })
  }

  private async readTarget(
    input: DesktopGitPushPreviewInput | DesktopGitPushConfirmInput,
    repository: GitRepositoryIdentity,
    signal: AbortSignal,
  ): Promise<GitPushState> {
    return this.git.pushTarget({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
    }, signal)
  }

  private async reconcileAfterError(
    input: DesktopGitPushConfirmInput,
    repository: GitRepositoryIdentity,
    pending: PendingGitPushPreview,
    error: unknown,
  ): Promise<GitPushResult> {
    let current: GitPushState | undefined
    try {
      current = await this.readTarget(input, repository, new AbortController().signal)
    } catch {
      // No durable conclusion can be drawn without a fresh read from the push remote.
    }
    if (current !== undefined && samePushDestination(current, pending.target) &&
      current.upstreamHead === pending.target.head) {
      const result = {
        operationId: input.previewId,
        remote: pending.target.remote,
        remoteRef: pending.target.remoteRef,
        head: pending.target.head,
      }
      this.recordSuccess(input.previewId, result.head)
      return result
    }
    if (errorCode(error) === 'CONFLICT' && current !== undefined &&
      samePushDestination(current, pending.target) && current.upstreamHead === pending.target.upstreamHead) {
      try {
        this.journal.recordOutcome(input.previewId, 'failed', 'git-rejected')
      } catch {
        throw new GitPushControllerError(
          'CONFLICT',
          'Git did not update the remote, but the durable outcome could not be recorded. Refresh before retrying.',
        )
      }
      throw new GitPushControllerError('CONFLICT', error instanceof Error ? error.message : 'Git rejected the Push.')
    }
    this.recordAmbiguous(input.previewId)
    throw new GitPushControllerError(
      'CONFLICT',
      'The Push result is ambiguous. Refresh the remote state; this approval will not be replayed.',
    )
  }

  private resolveDuplicate(
    input: DesktopGitPushConfirmInput,
    repository: GitRepositoryIdentity,
  ): GitPushResult {
    const existing = this.journal.get(input.previewId)
    if (existing === undefined || existing.kind !== 'push' || existing.push === undefined ||
      existing.approval === undefined) {
      throw new GitPushControllerError('NOT_FOUND', 'The Push preview is missing or expired. Create a new preview.')
    }
    const duplicate = this.journal.begin({
      operationId: input.previewId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
      repositoryCommonDir: repository.commonDir,
      kind: 'push',
      requestedPaths: existing.requestedPaths,
      paths: existing.paths,
      approval: existing.approval,
      push: existing.push,
    }).record
    if (gitMutationPhase(duplicate) !== 'succeeded') {
      throw new GitPushControllerError('DUPLICATE_REQUEST', duplicateMessage(duplicate))
    }
    return {
      operationId: duplicate.operationId,
      remote: duplicate.push!.remote,
      remoteRef: duplicate.push!.remoteRef,
      head: duplicate.push!.head,
    }
  }

  private recordSuccess(operationId: string, head: string): void {
    try {
      this.journal.recordOutcome(operationId, 'succeeded', 'completed')
    } catch {
      throw new GitPushControllerError(
        'CONFLICT',
        `Git pushed commit ${head}, but the durable outcome could not be recorded. Refresh the remote state.`,
      )
    }
  }

  private recordAmbiguous(operationId: string): void {
    try {
      this.journal.recordOutcome(operationId, 'ambiguous', 'result-ambiguous')
    } catch {
      // A dispatched Push is never replayed when either Git or durable state is uncertain.
    }
  }

  private assertNotExpired(pending: PendingGitPushPreview, message: string): void {
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      this.previews.delete(pending.previewId)
      throw new GitPushControllerError('CONFLICT', message)
    }
  }

  private pruneExpired(now: Date): void {
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now.getTime()) this.previews.delete(id)
    }
  }
}
