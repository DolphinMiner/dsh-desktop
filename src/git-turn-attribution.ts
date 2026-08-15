import type {
  GitRepositoryIdentity,
  GitReviewParams,
  GitReviewSnapshot,
  GitReviewTurnAttribution,
  GitTurnBoundaryParams,
  GitTurnBoundaryResult,
} from '@dolphinminer/dsh-desktop-protocol'

import type { GitWorkingTreeCapture } from './git-service'
import {
  GitTurnAttributionJournal,
  type GitTurnAttributionRecord,
} from './git-turn-attribution-journal'
import type { WorkspaceGitAuthorizer } from './workspace-git'

export interface GitTurnAttributionOperations {
  discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity>
  captureWorkingTree(repositoryRoot: string, signal?: AbortSignal): Promise<GitWorkingTreeCapture>
  reviewTreeRange(
    repositoryRoot: string,
    fromTree: string,
    toTree: string,
    attribution: GitReviewTurnAttribution,
    signal?: AbortSignal,
  ): Promise<GitReviewSnapshot>
}

export class GitTurnAttributionError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'DESKTOP_UNAVAILABLE' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'GitTurnAttributionError'
  }
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function duplicateResult(record: GitTurnAttributionRecord): GitTurnBoundaryResult {
  if (record.state === 'unavailable') return { accepted: false, state: 'unavailable' }
  if (record.state === 'not-completed') return { accepted: true, state: 'closed' }
  return { accepted: true, state: 'duplicate' }
}

export class GitTurnAttributionService {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly git: GitTurnAttributionOperations,
    private readonly journal: GitTurnAttributionJournal,
    private readonly authorize: WorkspaceGitAuthorizer,
  ) {}

  reportBoundary(params: GitTurnBoundaryParams, signal: AbortSignal): Promise<GitTurnBoundaryResult> {
    return this.serial(params.sessionId, () => this.reportBoundaryNow(params, signal))
  }

  async reviewCompletedTurn(
    params: GitReviewParams,
    repository: GitRepositoryIdentity,
    signal: AbortSignal,
  ): Promise<GitReviewSnapshot> {
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    const record = this.journal.latestCompleted(params.sessionId, params.workspaceRoot)
    if (record === undefined) {
      throw new GitTurnAttributionError('NOT_FOUND', 'This session has no completed turn with Git attribution.')
    }
    if (record.state === 'capturing-end') {
      throw new GitTurnAttributionError('CONFLICT', 'The latest completed turn is still being attributed.')
    }
    if (record.state !== 'captured' || record.repository === undefined || record.startTree === undefined ||
      record.endTree === undefined || record.startEventSeq === undefined || record.startEventTime === undefined ||
      record.endEventSeq === undefined || record.endEventTime === undefined) {
      throw new GitTurnAttributionError(
        'DESKTOP_UNAVAILABLE',
        'Changes for the latest completed turn could not be attributed safely.',
      )
    }
    if (!sameRepository(record.repository, repository)) {
      throw new GitTurnAttributionError(
        'CONFLICT',
        'The repository identity changed after the completed turn was attributed.',
      )
    }
    const attribution: GitReviewTurnAttribution = {
      sessionId: record.sessionId,
      turn: record.turn,
      startEventSeq: record.startEventSeq,
      endEventSeq: record.endEventSeq,
      startedAt: new Date(record.startEventTime).toISOString(),
      completedAt: new Date(record.endEventTime).toISOString(),
    }
    const review = await this.git.reviewTreeRange(
      repository.root,
      record.startTree,
      record.endTree,
      attribution,
      signal,
    )
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (!sameRepository(review.repository, repository) || review.attributedTurn?.sessionId !== params.sessionId ||
      review.attributedTurn.turn !== record.turn) {
      throw new GitTurnAttributionError('CONFLICT', 'The repository changed during completed-turn review.')
    }
    return review
  }

  private async reportBoundaryNow(
    params: GitTurnBoundaryParams,
    signal: AbortSignal,
  ): Promise<GitTurnBoundaryResult> {
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (params.boundary === 'start') {
      const begun = this.journal.beginStart(params)
      if (!begun.capture) return duplicateResult(begun.record)
      try {
        const repository = await this.git.discoverRepository(params.workspaceRoot, signal)
        const capture = await this.git.captureWorkingTree(repository.root, signal)
        this.authorize(params.sessionId, params.workspaceRoot, signal)
        if (!sameRepository(capture.repository, repository)) {
          this.journal.failStart(params, 'repository-changed')
          return { accepted: false, state: 'unavailable' }
        }
        this.journal.completeStart(params, capture.repository, capture.tree)
        return { accepted: true, state: 'started' }
      } catch {
        this.journal.failStart(params, 'capture-failed')
        return { accepted: false, state: 'unavailable' }
      }
    }

    const begun = this.journal.beginEnd(params)
    if (!begun.capture) return duplicateResult(begun.record)
    const expectedRepository = begun.record.repository!
    try {
      const capture = await this.git.captureWorkingTree(expectedRepository.root, signal)
      this.authorize(params.sessionId, params.workspaceRoot, signal)
      if (!sameRepository(capture.repository, expectedRepository)) {
        this.journal.failEnd(params, 'repository-changed')
        return { accepted: false, state: 'unavailable' }
      }
      this.journal.completeEnd(params, capture.repository, capture.tree)
      return { accepted: true, state: 'captured' }
    } catch {
      this.journal.failEnd(params, 'capture-failed')
      return { accepted: false, state: 'unavailable' }
    }
  }

  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(work)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(sessionId, tail)
    void tail.finally(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
    })
    return result
  }
}
