import type {
  DesktopProtocolError,
  GitDiscoverParams,
  GitRepositoryIdentity,
  GitStatusParams,
  GitStatusSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitServiceError } from './git-service'

export interface GitRepositoryOperations {
  discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity>
  status(repositoryRoot: string, signal?: AbortSignal): Promise<GitStatusSnapshot>
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
}
