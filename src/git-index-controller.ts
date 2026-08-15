import type {
  DesktopGitIndexMutationInput,
  DesktopProtocolError,
  GitIndexMutationParams,
  GitIndexMutationResult,
  GitRepositoryIdentity,
  GitStatusEntry,
  GitStatusParams,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  GitMutationJournal,
  gitMutationPhase,
  type GitMutationRecord,
} from './git-mutation-journal'

export interface GitIndexWorkspace {
  discover(input: DesktopGitIndexMutationInput, signal: AbortSignal): Promise<GitRepositoryIdentity>
  status(input: GitStatusParams, signal: AbortSignal): Promise<GitStatusSnapshot>
  mutateIndex(input: GitIndexMutationParams, signal: AbortSignal): Promise<GitStatusSnapshot>
}

export class GitIndexControllerError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'GitIndexControllerError'
  }
}

function canStage(entry: GitStatusEntry): boolean {
  return entry.kind === 'untracked' || entry.kind === 'unmerged' || entry.worktreeStatus !== '.'
}

function canUnstage(entry: GitStatusEntry): boolean {
  return entry.kind !== 'untracked' && entry.kind !== 'ignored' && entry.kind !== 'unmerged' &&
    entry.indexStatus !== '.'
}

export function selectGitIndexMutationPaths(
  status: GitStatusSnapshot,
  kind: GitIndexMutationParams['kind'],
  requestedPaths: readonly string[],
): string[] {
  const entries = new Map<string, GitStatusEntry>()
  for (const entry of status.entries) {
    if (entries.has(entry.path)) {
      throw new GitIndexControllerError('CONFLICT', 'Git returned duplicate status paths. Refresh and try again.')
    }
    entries.set(entry.path, entry)
  }

  const selected = new Set<string>()
  for (const path of requestedPaths) {
    const entry = entries.get(path)
    const eligible = entry !== undefined && (kind === 'stage' ? canStage(entry) : canUnstage(entry))
    if (!eligible || entry === undefined) {
      throw new GitIndexControllerError(
        'CONFLICT',
        `The selected file is no longer available to ${kind}. Refresh the review and try again.`,
      )
    }
    selected.add(entry.path)
    if (entry.kind === 'renamed') selected.add(entry.originalPath!)
  }
  return [...selected]
}

class RepositoryMutationQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(repositoryRoot: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repositoryRoot) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(repositoryRoot, tail)
    return result.finally(() => {
      if (this.tails.get(repositoryRoot) === tail) this.tails.delete(repositoryRoot)
    })
  }
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function duplicateMessage(record: GitMutationRecord): string {
  const phase = gitMutationPhase(record)
  if (phase === 'ambiguous' || phase === 'dispatch') {
    return 'This Git operation may already have changed the index. Refresh Git status before deciding what to do.'
  }
  if (phase === 'cancelled') {
    return 'This Git operation was cancelled before dispatch and will not be replayed. Start a new operation.'
  }
  return 'This Git operation identifier has already been completed and cannot be replayed.'
}

export class GitIndexController {
  private readonly queue = new RepositoryMutationQueue()

  constructor(
    private readonly git: GitIndexWorkspace,
    private readonly journal: GitMutationJournal,
  ) {}

  async mutate(input: DesktopGitIndexMutationInput, signal: AbortSignal): Promise<GitIndexMutationResult> {
    const discovered = await this.git.discover(input, signal)
    return this.queue.run(discovered.root, async () => {
      const repository = await this.git.discover(input, signal)
      if (!sameRepository(discovered, repository)) {
        throw new GitIndexControllerError('CONFLICT', 'The active workspace repository changed before the operation.')
      }

      const existing = this.journal.get(input.requestId)
      if (existing !== undefined) {
        const duplicate = this.journal.begin({
          operationId: input.requestId,
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          repositoryRoot: repository.root,
          repositoryCommonDir: repository.commonDir,
          kind: input.kind,
          requestedPaths: input.paths,
          paths: existing.paths,
        }).record
        if (gitMutationPhase(duplicate) !== 'succeeded') {
          throw new GitIndexControllerError('DUPLICATE_REQUEST', duplicateMessage(duplicate))
        }
        const status = await this.git.status({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          repositoryRoot: repository.root,
        }, signal)
        return { operationId: input.requestId, kind: input.kind, status }
      }

      const status = await this.git.status({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
      }, signal)
      const paths = selectGitIndexMutationPaths(status, input.kind, input.paths)
      this.journal.begin({
        operationId: input.requestId,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        repositoryRoot: repository.root,
        repositoryCommonDir: repository.commonDir,
        kind: input.kind,
        requestedPaths: input.paths,
        paths,
      })
      this.journal.recordDispatch(input.requestId)

      let updated: GitStatusSnapshot
      try {
        updated = await this.git.mutateIndex({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          repositoryRoot: repository.root,
          requestId: input.requestId,
          kind: input.kind,
          paths,
        }, signal)
      } catch {
        try {
          this.journal.recordOutcome(input.requestId, 'ambiguous', 'result-ambiguous')
        } catch {
          // The operation was already dispatched, so a journal failure cannot make replay safe.
        }
        throw new GitIndexControllerError(
          'CONFLICT',
          'The Git operation result is ambiguous. Refresh Git status; this request will not be replayed.',
        )
      }

      try {
        this.journal.recordOutcome(input.requestId, 'succeeded', 'completed')
      } catch {
        throw new GitIndexControllerError(
          'CONFLICT',
          'Git changed the index, but the durable outcome could not be recorded. Refresh Git status before continuing.',
        )
      }
      return { operationId: input.requestId, kind: input.kind, status: updated }
    })
  }
}
