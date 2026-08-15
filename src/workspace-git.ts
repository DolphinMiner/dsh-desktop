import type {
  DesktopProtocolError,
  GitCommitParams,
  GitCommitResult,
  GitDiscoverParams,
  GitIndexMutationParams,
  GitRevertParams,
  GitRepositoryIdentity,
  GitReviewParams,
  GitReviewScope,
  GitReviewSnapshot,
  GitStatusParams,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitServiceError } from './git-service'

export interface GitRepositoryOperations {
  discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity>
  status(repositoryRoot: string, signal?: AbortSignal): Promise<GitStatusSnapshot>
  review(repositoryRoot: string, scope: GitReviewScope, signal?: AbortSignal): Promise<GitReviewSnapshot>
  mutateIndex(
    repositoryRoot: string,
    kind: GitIndexMutationParams['kind'],
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitStatusSnapshot>
  revertWorktree(repositoryRoot: string, path: string, signal?: AbortSignal): Promise<GitStatusSnapshot>
  indexTree(repositoryRoot: string, signal?: AbortSignal): Promise<string>
  commit(
    repositoryRoot: string,
    message: string,
    expectedHead: string | undefined,
    expectedTree: string,
    signal?: AbortSignal,
  ): Promise<Omit<GitCommitResult, 'operationId'>>
}

export type WorkspaceGitAuthorizer = (
  sessionId: string,
  workspaceRoot: string,
  signal: AbortSignal,
) => void

export class WorkspaceGitError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'WorkspaceGitError'
  }
}

function mapGitError(error: unknown): never {
  if (!(error instanceof GitServiceError)) throw error
  if (error.code === 'CANCELLED') throw new DOMException(error.message, 'AbortError')
  const code = error.code === 'TIMEOUT'
    ? 'TIMEOUT'
    : error.code === 'NOT_REPOSITORY'
      ? 'NOT_FOUND'
      : error.code === 'INVALID_INPUT'
        ? 'BAD_MESSAGE'
        : error.code === 'UNAVAILABLE'
          ? 'DESKTOP_UNAVAILABLE'
          : error.code === 'GIT_FAILED'
            ? 'CONFLICT'
            : 'INTERNAL_ERROR'
  throw new WorkspaceGitError(code, error.message)
}

export class WorkspaceGitCapabilityService {
  constructor(
    private readonly git: GitRepositoryOperations,
    private readonly authorize: WorkspaceGitAuthorizer,
  ) {}

  async discover(params: GitDiscoverParams, signal: AbortSignal): Promise<GitRepositoryIdentity> {
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    let repository: GitRepositoryIdentity
    try {
      repository = await this.git.discoverRepository(params.workspaceRoot, signal)
    } catch (error) {
      mapGitError(error)
    }
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    return repository
  }

  async status(params: GitStatusParams, signal: AbortSignal): Promise<GitStatusSnapshot> {
    const repository = await this.discover(params, signal)
    if (repository.root !== params.repositoryRoot) {
      throw new WorkspaceGitError(
        'BAD_MESSAGE',
        'The repository root does not match the active workspace repository.',
      )
    }
    let snapshot: GitStatusSnapshot
    try {
      snapshot = await this.git.status(repository.root, signal)
    } catch (error) {
      mapGitError(error)
    }
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (snapshot.repository.root !== repository.root ||
      snapshot.repository.gitDir !== repository.gitDir ||
      snapshot.repository.commonDir !== repository.commonDir) {
      throw new WorkspaceGitError('CONFLICT', 'The active workspace repository changed during Git status.')
    }
    return snapshot
  }

  async review(params: GitReviewParams, signal: AbortSignal): Promise<GitReviewSnapshot> {
    const repository = await this.discover(params, signal)
    if (repository.root !== params.repositoryRoot) {
      throw new WorkspaceGitError(
        'BAD_MESSAGE',
        'The repository root does not match the active workspace repository.',
      )
    }
    let snapshot: GitReviewSnapshot
    try {
      snapshot = await this.git.review(repository.root, params.scope, signal)
    } catch (error) {
      mapGitError(error)
    }
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (snapshot.repository.root !== repository.root ||
      snapshot.repository.gitDir !== repository.gitDir ||
      snapshot.repository.commonDir !== repository.commonDir) {
      throw new WorkspaceGitError('CONFLICT', 'The active workspace repository changed during Git review.')
    }
    return snapshot
  }

  async mutateIndex(params: GitIndexMutationParams, signal: AbortSignal): Promise<GitStatusSnapshot> {
    const repository = await this.discover(params, signal)
    if (repository.root !== params.repositoryRoot) {
      throw new WorkspaceGitError(
        'BAD_MESSAGE',
        'The repository root does not match the active workspace repository.',
      )
    }
    let snapshot: GitStatusSnapshot
    try {
      snapshot = await this.git.mutateIndex(repository.root, params.kind, params.paths, signal)
    } catch (error) {
      mapGitError(error)
    }
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (snapshot.repository.root !== repository.root ||
      snapshot.repository.gitDir !== repository.gitDir ||
      snapshot.repository.commonDir !== repository.commonDir) {
      throw new WorkspaceGitError('CONFLICT', 'The active workspace repository changed during the Git operation.')
    }
    return snapshot
  }

  async revertWorktree(params: GitRevertParams, signal: AbortSignal): Promise<GitStatusSnapshot> {
    const repository = await this.discover(params, signal)
    if (repository.root !== params.repositoryRoot) {
      throw new WorkspaceGitError(
        'BAD_MESSAGE',
        'The repository root does not match the active workspace repository.',
      )
    }
    let snapshot: GitStatusSnapshot
    try {
      snapshot = await this.git.revertWorktree(repository.root, params.path, signal)
    } catch (error) {
      mapGitError(error)
    }
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (snapshot.repository.root !== repository.root ||
      snapshot.repository.gitDir !== repository.gitDir ||
      snapshot.repository.commonDir !== repository.commonDir) {
      throw new WorkspaceGitError('CONFLICT', 'The active workspace repository changed during the Git operation.')
    }
    return snapshot
  }

  async indexTree(params: GitStatusParams, signal: AbortSignal): Promise<string> {
    const repository = await this.discover(params, signal)
    if (repository.root !== params.repositoryRoot) {
      throw new WorkspaceGitError(
        'BAD_MESSAGE',
        'The repository root does not match the active workspace repository.',
      )
    }
    let tree: string
    try {
      tree = await this.git.indexTree(repository.root, signal)
    } catch (error) {
      mapGitError(error)
    }
    const current = await this.discover(params, signal)
    if (current.root !== repository.root || current.gitDir !== repository.gitDir ||
      current.commonDir !== repository.commonDir) {
      throw new WorkspaceGitError('CONFLICT', 'The active workspace repository changed during the Git operation.')
    }
    return tree
  }

  async commit(params: GitCommitParams, signal: AbortSignal): Promise<GitCommitResult> {
    const repository = await this.discover(params, signal)
    if (repository.root !== params.repositoryRoot) {
      throw new WorkspaceGitError(
        'BAD_MESSAGE',
        'The repository root does not match the active workspace repository.',
      )
    }
    let result: Omit<GitCommitResult, 'operationId'>
    try {
      result = await this.git.commit(
        repository.root,
        params.message,
        params.expectedHead,
        params.expectedTree,
        signal,
      )
    } catch (error) {
      mapGitError(error)
    }
    this.authorize(params.sessionId, params.workspaceRoot, signal)
    if (result.status.repository.root !== repository.root ||
      result.status.repository.gitDir !== repository.gitDir ||
      result.status.repository.commonDir !== repository.commonDir || result.status.head !== result.commit) {
      throw new WorkspaceGitError('CONFLICT', 'The active workspace repository changed during the Git commit.')
    }
    return { operationId: params.operationId, ...result }
  }
}
