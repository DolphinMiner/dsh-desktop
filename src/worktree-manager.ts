import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  DesktopProtocolError,
  GitRepositoryIdentity,
  WorktreeRecoveryReason,
  WorktreeSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import { GitCreateWorktreeInput, GitServiceError, GitWorktreeEntry } from './git-service'
import type { WorkspaceGitAuthorizer } from './workspace-git'
import {
  summarizeWorktreeRecord,
  WorktreeRecord,
  WorktreeRegistry,
  WorktreeRegistryError,
} from './worktree-registry'

const MAX_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024

export interface WorktreeGitOperations {
  discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity>
  resolveCommit(repositoryRoot: string, ref: string, signal?: AbortSignal): Promise<string>
  listWorktrees(repositoryRoot: string, signal?: AbortSignal): Promise<GitWorktreeEntry[]>
  createWorktree(input: GitCreateWorktreeInput, signal?: AbortSignal): Promise<GitRepositoryIdentity>
}

export interface ProvisionWorktreeInput {
  operationId: string
  requestedBySessionId: string
  workspaceRoot: string
  baseRef: string
}

export interface ProvisionWorktreeResult {
  record: WorktreeRecord
  created: boolean
}

export interface WorktreeSessionBindingInput {
  sessionId: string
  workspacePath: string
}

export interface WorktreeReconciliationResult {
  repositories: number
  inspected: number
  healthy: number
  recoveryRequired: number
  snapshot: WorktreeSnapshot
}

export class WorktreeManagerError extends Error {
  constructor(
    readonly code: DesktopProtocolError['code'],
    message: string,
    readonly ambiguous = false,
  ) {
    super(message)
    this.name = 'WorktreeManagerError'
  }
}

function isBoundedString(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function validateInput(input: ProvisionWorktreeInput): void {
  if (!isBoundedString(input.operationId, MAX_ID_LENGTH) ||
    !isBoundedString(input.requestedBySessionId, MAX_ID_LENGTH) ||
    !isBoundedString(input.workspaceRoot, MAX_PATH_LENGTH) ||
    !isBoundedString(input.baseRef, MAX_REF_LENGTH) || /[\r\n]/.test(input.baseRef)) {
    throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree creation request is invalid.')
  }
}

function mapError(error: unknown, ambiguous = false): never {
  if (error instanceof WorktreeManagerError) throw error
  if (error instanceof WorktreeRegistryError) {
    throw new WorktreeManagerError(error.code, error.message, ambiguous)
  }
  if (error instanceof GitServiceError) {
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
    throw new WorktreeManagerError(code, error.message, ambiguous)
  }
  throw new WorktreeManagerError('DESKTOP_UNAVAILABLE', 'The worktree operation failed.', ambiguous)
}

async function withMappedError<T>(operation: () => Promise<T>, ambiguous = false): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    mapError(error, ambiguous)
  }
}

function withMappedErrorSync<T>(operation: () => T, ambiguous = false): T {
  try {
    return operation()
  } catch (error) {
    mapError(error, ambiguous)
  }
}

function isUnavailableCheckout(error: unknown): boolean {
  return error instanceof GitServiceError &&
    (error.code === 'INVALID_INPUT' || error.code === 'NOT_REPOSITORY')
}

function throwIfCancelled(error: unknown): void {
  if (error instanceof GitServiceError && error.code === 'CANCELLED') {
    throw new DOMException(error.message, 'AbortError')
  }
  if (error instanceof DOMException && error.name === 'AbortError') throw error
}

function expectedLockReason(record: WorktreeRecord): string | undefined {
  const prefix = 'refs/heads/dsh/session-'
  if (record.branch?.startsWith(prefix) !== true) return undefined
  return `DSH Desktop session ${record.branch.slice(prefix.length, prefix.length + 12)}`
}

export class WorktreeManager {
  constructor(
    private readonly git: WorktreeGitOperations,
    private readonly registry: WorktreeRegistry,
    private readonly managedRoot: string,
    private readonly authorize: WorkspaceGitAuthorizer,
  ) {}

  snapshot(): WorktreeSnapshot {
    const status = this.registry.status()
    if (!status.available) {
      throw new WorktreeManagerError('DESKTOP_UNAVAILABLE', status.message ?? 'The worktree registry is unavailable.')
    }
    return {
      revision: status.revision,
      worktrees: this.registry.list()
        .filter(record => record.lifecycle !== 'removed')
        .map(summarizeWorktreeRecord),
    }
  }

  async reconcile(signal: AbortSignal): Promise<WorktreeReconciliationResult> {
    const records = withMappedErrorSync(() => this.registry.list())
      .filter(record => record.lifecycle !== 'removed')
    const groups = new Map<string, WorktreeRecord[]>()
    for (const record of records) {
      const group = groups.get(record.repository.commonDir) ?? []
      group.push(record)
      groups.set(record.repository.commonDir, group)
    }
    const recovery = new Map<string, WorktreeRecoveryReason>()
    let healthy = 0

    for (const [commonDir, group] of groups) {
      if (signal.aborted) throw new DOMException('Worktree reconciliation was cancelled.', 'AbortError')
      const candidates = [...new Set(group.flatMap(record => [
        record.repository.root,
        ...(record.worktreePath === undefined ? [] : [record.worktreePath]),
      ]))]
      let entries: GitWorktreeEntry[] | undefined
      let inspectionFailed = false
      const mismatchedCandidates = new Set<string>()
      for (const candidate of candidates) {
        try {
          const repository = await this.git.discoverRepository(candidate, signal)
          if (repository.commonDir !== commonDir) {
            mismatchedCandidates.add(candidate)
            continue
          }
          entries = await this.git.listWorktrees(repository.root, signal)
          break
        } catch (error) {
          throwIfCancelled(error)
          if (!isUnavailableCheckout(error)) inspectionFailed = true
        }
      }
      if (entries === undefined) {
        for (const record of group) {
          const checkout = record.executionMode === 'local' ? record.repository.root : record.worktreePath!
          recovery.set(record.id, mismatchedCandidates.has(checkout)
            ? 'external-change'
            : inspectionFailed ? 'inspection-failed' : 'missing')
        }
        continue
      }

      const byPath = new Map(entries.map(entry => [entry.path, entry]))
      for (const record of group) {
        const checkout = record.executionMode === 'local' ? record.repository.root : record.worktreePath!
        let repository: GitRepositoryIdentity | undefined
        try {
          repository = await this.git.discoverRepository(checkout, signal)
        } catch (error) {
          throwIfCancelled(error)
          if (!isUnavailableCheckout(error)) {
            recovery.set(record.id, 'inspection-failed')
            continue
          }
        }
        if (repository !== undefined &&
          (repository.root !== checkout || repository.commonDir !== record.repository.commonDir)) {
          recovery.set(record.id, 'external-change')
          continue
        }
        const entry = byPath.get(checkout)
        if (repository === undefined) {
          const moved = record.branch === undefined
            ? undefined
            : entries.find(candidate => candidate.branch === record.branch && candidate.path !== checkout)
          recovery.set(record.id, moved === undefined ? 'missing' : 'moved')
          continue
        }
        if (entry === undefined) {
          recovery.set(record.id, 'external-change')
          continue
        }
        if (entry.prunable) {
          recovery.set(record.id, 'missing')
          continue
        }
        if (record.executionMode === 'worktree') {
          if (entry.bare || entry.detached || entry.branch !== record.branch) {
            recovery.set(record.id, 'external-change')
            continue
          }
          const lockReason = expectedLockReason(record)
          if (!entry.locked || lockReason === undefined || entry.lockReason !== lockReason) {
            recovery.set(record.id, 'locked')
            continue
          }
        }
        healthy += 1
      }
    }

    if (recovery.size > 0) {
      withMappedErrorSync(() => this.registry.requireRecoveryBatch(
        [...recovery].map(([id, reason]) => ({ id, reason })),
      ), true)
    }
    const snapshot = this.snapshot()
    return {
      repositories: groups.size,
      inspected: records.length,
      healthy,
      recoveryRequired: snapshot.worktrees.filter(worktree => worktree.lifecycle === 'recovery-required').length,
      snapshot,
    }
  }

  async provision(input: ProvisionWorktreeInput, signal: AbortSignal): Promise<ProvisionWorktreeResult> {
    validateInput(input)
    this.authorize(input.requestedBySessionId, input.workspaceRoot, signal)
    const repository = await withMappedError(() =>
      this.git.discoverRepository(input.workspaceRoot, signal))
    this.authorize(input.requestedBySessionId, input.workspaceRoot, signal)
    const baseCommit = await withMappedError(() =>
      this.git.resolveCommit(repository.root, input.baseRef, signal))
    const root = await withMappedError(async () => {
      await mkdir(this.managedRoot, { recursive: true, mode: 0o700 })
      return realpath(this.managedRoot)
    })
    this.authorize(input.requestedBySessionId, input.workspaceRoot, signal)

    const digest = createHash('sha256')
      .update(repository.commonDir)
      .update('\0')
      .update(input.requestedBySessionId)
      .update('\0')
      .update(input.operationId)
      .digest('hex')
    const worktreePath = join(root, digest.slice(0, 32))
    const branch = `dsh/session-${digest.slice(0, 24)}`
    const { previous, record } = withMappedErrorSync(() => {
      const previous = this.registry.getByCreationOperation(input.operationId)
      const record = this.registry.reserve({
        operationId: input.operationId,
        repository,
        requestedBySessionId: input.requestedBySessionId,
        executionMode: 'worktree',
        worktreePath,
        baseRef: input.baseRef,
        baseCommit,
        branch: `refs/heads/${branch}`,
      })
      return { previous, record }
    })
    if (previous !== undefined) {
      if (record.lifecycle === 'ready') {
        try {
          const observed = await this.git.discoverRepository(record.worktreePath!, signal)
          if (observed.root !== record.worktreePath ||
            observed.commonDir !== record.repository.commonDir) {
            throw new WorktreeManagerError(
              'CONFLICT',
              'The registered worktree no longer matches its Git repository.',
              true,
            )
          }
        } catch (error) {
          try {
            this.registry.requireRecovery(record.id, 'external-change')
          } catch (registryError) {
            mapError(registryError, true)
          }
          mapError(error, true)
        }
        this.authorize(input.requestedBySessionId, input.workspaceRoot, signal)
        return { record, created: false }
      }
      throw new WorktreeManagerError(
        'CONFLICT',
        'This worktree operation already exists and must be recovered before it can continue.',
        true,
      )
    }

    try {
      const created = await this.git.createWorktree({
        repositoryRoot: repository.root,
        worktreePath,
        branch,
        commit: baseCommit,
        lockReason: `DSH Desktop session ${digest.slice(0, 12)}`,
      }, signal)
      if (created.root !== worktreePath || created.commonDir !== repository.commonDir) {
        throw new WorktreeManagerError(
          'CONFLICT',
          'Git created a worktree with an unexpected repository identity.',
          true,
        )
      }
    } catch (error) {
      try {
        this.registry.requireRecovery(record.id, 'create-ambiguous')
      } catch (registryError) {
        mapError(registryError, true)
      }
      mapError(error, true)
    }

    const ready = withMappedErrorSync(() => this.registry.markReady(record.id, input.operationId), true)
    this.authorize(input.requestedBySessionId, input.workspaceRoot, signal)
    return { record: ready, created: true }
  }

  async bindSession(input: WorktreeSessionBindingInput, signal: AbortSignal): Promise<WorktreeRecord | undefined> {
    if (!isBoundedString(input.sessionId, MAX_ID_LENGTH) ||
      !isBoundedString(input.workspacePath, MAX_PATH_LENGTH) || !isAbsolute(input.workspacePath)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree session binding is invalid.')
    }
    const managedRoot = resolve(this.managedRoot)
    const requestedPath = resolve(input.workspacePath)
    const requestedRecord = withMappedErrorSync(() => this.registry.getByCheckoutPath(requestedPath))
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(managedRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && requestedRecord === undefined) return undefined
      if (requestedRecord !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          this.registry.requireRecovery(requestedRecord.id, 'missing')
        } catch (registryError) {
          mapError(registryError, true)
        }
      }
      mapError(error, requestedRecord !== undefined)
    }
    const lexicalRelative = relative(managedRoot, requestedPath)
    const canonicalLexicalRelative = relative(canonicalRoot!, requestedPath)
    const isManagedCandidate = (value: string): boolean =>
      value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
    if (!isManagedCandidate(lexicalRelative) && !isManagedCandidate(canonicalLexicalRelative)) return undefined

    let canonicalPath: string
    try {
      canonicalPath = await realpath(requestedPath)
    } catch (error) {
      if (requestedRecord !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          this.registry.requireRecovery(requestedRecord.id, 'missing')
        } catch (registryError) {
          mapError(registryError, true)
        }
      }
      if (requestedRecord === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      mapError(error, requestedRecord !== undefined)
    }
    const canonicalRelative = relative(canonicalRoot, canonicalPath!)
    const record = requestedRecord ?? withMappedErrorSync(() => this.registry.getByCheckoutPath(canonicalPath!))
    if (record === undefined) return undefined
    if (!isManagedCandidate(canonicalRelative) || canonicalPath !== record.worktreePath) {
      try {
        this.registry.requireRecovery(record.id, 'moved')
      } catch (registryError) {
        mapError(registryError, true)
      }
      throw new WorktreeManagerError('CONFLICT', 'The worktree path no longer matches its managed location.', true)
    }
    const observed = await withMappedError(() => this.git.discoverRepository(canonicalPath!, signal), true)
    if (observed.root !== canonicalPath || observed.commonDir !== record.repository.commonDir) {
      try {
        this.registry.requireRecovery(record.id, 'external-change')
      } catch (registryError) {
        mapError(registryError, true)
      }
      throw new WorktreeManagerError('CONFLICT', 'The worktree no longer matches its Git repository.', true)
    }
    return withMappedErrorSync(() => this.registry.bindSession(record.id, input.sessionId), true)
  }
}
