import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  DesktopProtocolError,
  GitRepositoryIdentity,
  MissingWorktreeRecoveryInspection,
  WorktreeCleanupInspection,
  WorktreeHandoffDirection,
  WorktreeHandoffPreflight,
  WorktreeRecoveryReason,
  WorktreeSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  GitCreateWorktreeInput,
  GitInspectWorktreeInput,
  GitInspectWorktreeHandoffInput,
  GitRemoveWorktreeInput,
  GitServiceError,
  GitTransferWorktreeHandoffInput,
  GitWorktreeHandoffOutcome,
  GitWorktreeHandoffInspection,
  GitWorktreeHandoffTransferResult,
  GitWorktreeEntry,
} from './git-service'
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
  inspectWorktreeForRemoval(
    input: GitInspectWorktreeInput,
    signal?: AbortSignal,
  ): Promise<WorktreeCleanupInspection>
  inspectWorktreeHandoff(
    input: GitInspectWorktreeHandoffInput,
    signal?: AbortSignal,
  ): Promise<GitWorktreeHandoffInspection>
  transferWorktreeHandoff(
    input: GitTransferWorktreeHandoffInput,
    signal?: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<GitWorktreeHandoffTransferResult>
  inspectWorktreeHandoffOutcome(
    input: GitTransferWorktreeHandoffInput,
    signal?: AbortSignal,
  ): Promise<GitWorktreeHandoffOutcome>
  removeWorktree(input: GitRemoveWorktreeInput, signal?: AbortSignal): Promise<void>
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
  recovered: number
  recoveryRequired: number
  orphaned: number
  snapshot: WorktreeSnapshot
}

export interface WorktreeReconciliationOptions {
  orphanUnboundReady?: boolean
}

export interface WorktreeCleanupState {
  record: WorktreeRecord
  inspection: WorktreeCleanupInspection
}

export interface InterruptedRemovalRecoveryState extends WorktreeCleanupState {
  removalOperationId: string
}

export interface MissingWorktreeRecoveryState {
  record: WorktreeRecord
  inspection: MissingWorktreeRecoveryInspection
}

export interface ManagedWorktreeHandoffExpectation {
  direction: WorktreeHandoffDirection
  baseCommit: string
  sourceTree: string
  sourceHead: string
  sourceBranch: string
  destinationBranch: string
}

export interface ManagedWorktreeHandoffTransferResult {
  record: WorktreeRecord
  result: GitWorktreeHandoffTransferResult
}

export interface WorktreeHandoffState {
  record: WorktreeRecord
  preflight: WorktreeHandoffPreflight
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

async function checkoutPathState(path: string): Promise<'absent' | 'present' | 'unknown'> {
  try {
    await lstat(path)
    return 'present'
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 'absent'
    return 'unknown'
  }
}

function expectedLockReason(record: WorktreeRecord): string | undefined {
  const prefix = 'refs/heads/dsh/session-'
  if (record.branch?.startsWith(prefix) !== true) return undefined
  return `DSH Desktop session ${record.branch.slice(prefix.length, prefix.length + 12)}`
}

function sameCleanupInspection(
  left: WorktreeCleanupInspection,
  right: WorktreeCleanupInspection,
): boolean {
  return left.worktreePath === right.worktreePath && left.head === right.head && left.branch === right.branch &&
    left.clean === right.clean && left.locked === right.locked && left.changes.length === right.changes.length &&
    left.changes.every((change, index) => {
      const other = right.changes[index]
      return other !== undefined && change.kind === other.kind && change.path === other.path &&
        change.originalPath === other.originalPath && change.indexStatus === other.indexStatus &&
        change.worktreeStatus === other.worktreeStatus
    })
}

function sameMissingWorktreeInspection(
  left: MissingWorktreeRecoveryInspection,
  right: MissingWorktreeRecoveryInspection,
): boolean {
  return left.repositoryRoot === right.repositoryRoot && left.worktreePath === right.worktreePath &&
    left.branch === right.branch && left.worktreeMetadataAbsent === right.worktreeMetadataAbsent &&
    left.checkoutPathAbsent === right.checkoutPathAbsent
}

function assertCleanupRecord(record: WorktreeRecord, action = 'cleanup'): asserts record is WorktreeRecord & {
  executionMode: 'worktree'
  worktreePath: string
  branch: string
} {
  if (record.executionMode !== 'worktree' || record.worktreePath === undefined || record.branch === undefined ||
    (record.lifecycle !== 'ready' && record.lifecycle !== 'orphaned') || record.pendingOperation !== undefined) {
    throw new WorktreeManagerError(
      'CONFLICT',
      `This worktree is not ready for ${action}. Resolve its recovery state first.`,
      record.lifecycle === 'recovery-required' || record.pendingOperation !== undefined,
    )
  }
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

  getByOperation(operationId: string): WorktreeRecord | undefined {
    if (!isBoundedString(operationId, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree operation identifier is invalid.')
    }
    return withMappedErrorSync(() => this.registry.getByOperation(operationId))
  }

  async inspectCleanup(id: string, signal: AbortSignal): Promise<WorktreeCleanupState> {
    if (!isBoundedString(id, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree identifier is invalid.')
    }
    const record = withMappedErrorSync(() => this.registry.get(id))
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    assertCleanupRecord(record)
    const lockReason = expectedLockReason(record)
    if (lockReason === undefined) {
      throw new WorktreeManagerError('CONFLICT', 'The managed worktree lock identity is invalid.', true)
    }
    const inspection = await withMappedError(() => this.git.inspectWorktreeForRemoval({
      repositoryRoot: record.repository.root,
      worktreePath: record.worktreePath,
      branch: record.branch,
      lockReason,
    }, signal), true)
    return { record, inspection }
  }

  async inspectInterruptedRemoval(
    id: string,
    signal: AbortSignal,
  ): Promise<InterruptedRemovalRecoveryState> {
    if (!isBoundedString(id, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree identifier is invalid.')
    }
    const record = withMappedErrorSync(() => this.registry.get(id))
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    if (record.executionMode !== 'worktree' || record.worktreePath === undefined || record.branch === undefined ||
      record.lifecycle !== 'recovery-required' || record.recoveryReason !== 'interrupted-remove' ||
      record.pendingOperation?.kind !== 'remove') {
      throw new WorktreeManagerError('CONFLICT', 'This worktree does not have an interrupted cleanup to keep.')
    }
    const worktreePath = record.worktreePath
    const branch = record.branch
    const lockReason = expectedLockReason(record)
    if (lockReason === undefined) {
      throw new WorktreeManagerError('CONFLICT', 'The managed worktree lock identity is invalid.', true)
    }
    const inspection = await withMappedError(() => this.git.inspectWorktreeForRemoval({
      repositoryRoot: record.repository.root,
      worktreePath,
      branch,
      lockReason,
    }, signal), true)
    return {
      record,
      inspection,
      removalOperationId: record.pendingOperation.id,
    }
  }

  async keepInterruptedRemoval(
    id: string,
    removalOperationId: string,
    expected: WorktreeCleanupInspection,
    signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    if (!isBoundedString(removalOperationId, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The interrupted remove operation identifier is invalid.')
    }
    const current = await this.inspectInterruptedRemoval(id, signal)
    if (current.removalOperationId !== removalOperationId ||
      !sameCleanupInspection(current.inspection, expected)) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The interrupted cleanup changed after approval. Inspect it again.',
      )
    }
    beforeCommit?.(current.record)
    return withMappedErrorSync(() => this.registry.keepInterruptedRemoval(id, removalOperationId), true)
  }

  async inspectMissingWorktree(
    id: string,
    signal: AbortSignal,
  ): Promise<MissingWorktreeRecoveryState> {
    if (!isBoundedString(id, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree identifier is invalid.')
    }
    const record = withMappedErrorSync(() => this.registry.get(id))
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    if (record.executionMode !== 'worktree' || record.worktreePath === undefined || record.branch === undefined ||
      record.lifecycle !== 'recovery-required' || record.recoveryReason !== 'missing' ||
      record.pendingOperation !== undefined) {
      throw new WorktreeManagerError('CONFLICT', 'This worktree does not have a missing checkout to forget.')
    }
    const repository = await withMappedError(() => this.git.discoverRepository(record.repository.root, signal), true)
    if (repository.root !== record.repository.root || repository.gitDir !== record.repository.gitDir ||
      repository.commonDir !== record.repository.commonDir) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The original repository identity changed. Recheck the worktree before resolving it.',
        true,
      )
    }
    const entries = await withMappedError(() => this.git.listWorktrees(repository.root, signal), true)
    if (entries.some(entry => entry.path === record.worktreePath)) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'Git still lists the missing checkout. Recheck or prune its metadata before forgetting it.',
      )
    }
    if (entries.some(entry => entry.branch === record.branch)) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The managed branch is checked out at another path. Recheck the worktree before resolving it.',
      )
    }
    const pathState = await checkoutPathState(record.worktreePath)
    if (pathState === 'present') {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The checkout path exists and will not be forgotten.',
        true,
      )
    }
    if (pathState === 'unknown') {
      throw new WorktreeManagerError(
        'DESKTOP_UNAVAILABLE',
        'The checkout path could not be verified as absent.',
        true,
      )
    }
    return {
      record,
      inspection: {
        repositoryRoot: repository.root,
        worktreePath: record.worktreePath,
        branch: record.branch,
        worktreeMetadataAbsent: true,
        checkoutPathAbsent: true,
      },
    }
  }

  async forgetMissingWorktree(
    id: string,
    resolutionOperationId: string,
    expected: MissingWorktreeRecoveryInspection,
    signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    if (!isBoundedString(resolutionOperationId, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The missing-worktree resolution identifier is invalid.')
    }
    const current = await this.inspectMissingWorktree(id, signal)
    if (!sameMissingWorktreeInspection(current.inspection, expected)) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The missing checkout changed after approval. Inspect it again.',
      )
    }
    beforeCommit?.(current.record)
    return withMappedErrorSync(() =>
      this.registry.forgetMissingWorktree(id, resolutionOperationId), true)
  }

  async inspectHandoff(
    id: string,
    direction: WorktreeHandoffDirection,
    signal: AbortSignal,
  ): Promise<WorktreeHandoffState> {
    if (!isBoundedString(id, MAX_ID_LENGTH) ||
      (direction !== 'local-to-worktree' && direction !== 'worktree-to-local')) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree handoff request is invalid.')
    }
    const record = withMappedErrorSync(() => this.registry.get(id))
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    assertCleanupRecord(record, 'handoff')
    const lockReason = expectedLockReason(record)
    if (lockReason === undefined) {
      throw new WorktreeManagerError('CONFLICT', 'The managed worktree lock identity is invalid.')
    }
    const inspection = await withMappedError(() => this.git.inspectWorktreeHandoff({
      repositoryRoot: record.repository.root,
      worktreePath: record.worktreePath,
      branch: record.branch,
      lockReason,
      baseCommit: record.baseCommit,
      direction,
    }, signal))
    return {
      record,
      preflight: { ...inspection, worktree: summarizeWorktreeRecord(record) },
    }
  }

  async transferHandoff(
    id: string,
    expected: ManagedWorktreeHandoffExpectation,
    signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<ManagedWorktreeHandoffTransferResult> {
    const { record, input } = this.handoffOperationInput(id, expected)
    let dispatched = false
    let dispatchBoundaryError: unknown
    try {
      const result = await this.git.transferWorktreeHandoff(input, signal, () => {
        try {
          beforeDispatch?.(record)
        } catch (error) {
          dispatchBoundaryError = error
          throw error
        }
        dispatched = true
      })
      return { record, result }
    } catch (error) {
      if (dispatchBoundaryError !== undefined) throw dispatchBoundaryError
      mapError(error, dispatched)
    }
  }

  async inspectHandoffOutcome(
    id: string,
    expected: ManagedWorktreeHandoffExpectation,
    signal: AbortSignal,
  ): Promise<GitWorktreeHandoffOutcome> {
    const { input } = this.handoffOperationInput(id, expected)
    return withMappedError(() => this.git.inspectWorktreeHandoffOutcome(input, signal), true)
  }

  private handoffOperationInput(
    id: string,
    expected: ManagedWorktreeHandoffExpectation,
  ): { record: WorktreeRecord; input: GitTransferWorktreeHandoffInput } {
    if (!isBoundedString(id, MAX_ID_LENGTH) ||
      (expected.direction !== 'local-to-worktree' && expected.direction !== 'worktree-to-local') ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected.baseCommit) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected.sourceTree) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected.sourceHead) ||
      !isBoundedString(expected.sourceBranch, MAX_REF_LENGTH) || /[\r\n]/.test(expected.sourceBranch) ||
      !isBoundedString(expected.destinationBranch, MAX_REF_LENGTH) || /[\r\n]/.test(expected.destinationBranch)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree handoff expectation is invalid.')
    }
    const record = withMappedErrorSync(() => this.registry.get(id))
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    assertCleanupRecord(record, 'handoff')
    if (record.baseCommit !== expected.baseCommit) {
      throw new WorktreeManagerError('CONFLICT', 'The managed worktree base changed after approval.', true)
    }
    const lockReason = expectedLockReason(record)
    if (lockReason === undefined) {
      throw new WorktreeManagerError('CONFLICT', 'The managed worktree lock identity is invalid.', true)
    }
    return {
      record,
      input: {
        repositoryRoot: record.repository.root,
        worktreePath: record.worktreePath,
        branch: record.branch,
        lockReason,
        baseCommit: record.baseCommit,
        direction: expected.direction,
        expectedSourceTree: expected.sourceTree,
        expectedSourceHead: expected.sourceHead,
        expectedSourceBranch: expected.sourceBranch,
        expectedDestinationBranch: expected.destinationBranch,
      },
    }
  }

  async removeCleanWorktree(
    id: string,
    operationId: string,
    expected: WorktreeCleanupInspection,
    signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    if (!expected.clean) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'A dirty worktree cannot be approved for cleanup.')
    }
    const existingOperation = this.getByOperation(operationId)
    if (existingOperation !== undefined) {
      if (existingOperation.id !== id || existingOperation.removalOperationId !== operationId ||
        existingOperation.lifecycle !== 'removed') {
        throw new WorktreeManagerError(
          'DUPLICATE_REQUEST',
          'This cleanup operation is incomplete or belongs to another worktree and will not be replayed.',
          true,
        )
      }
      return existingOperation
    }
    const current = await this.inspectCleanup(id, signal)
    if (!current.inspection.clean) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The managed worktree contains changes. Keep it or transfer those changes before cleanup.',
      )
    }
    if (!sameCleanupInspection(current.inspection, expected)) {
      throw new WorktreeManagerError('CONFLICT', 'The worktree changed after cleanup approval.')
    }
    beforeDispatch?.(current.record)
    const lockReason = expectedLockReason(current.record)!
    withMappedErrorSync(() => this.registry.beginRemoval(id, operationId), true)
    try {
      await this.git.removeWorktree({
        repositoryRoot: current.record.repository.root,
        worktreePath: current.inspection.worktreePath,
        head: current.inspection.head,
        branch: current.inspection.branch,
        lockReason,
      }, signal)
    } catch (error) {
      try {
        this.registry.requireRecovery(id, 'interrupted-remove')
      } catch (registryError) {
        mapError(registryError, true)
      }
      mapError(error, true)
    }
    return withMappedErrorSync(() => this.registry.markRemoved(id, operationId), true)
  }

  async reconcile(
    signal: AbortSignal,
    options: WorktreeReconciliationOptions = {},
  ): Promise<WorktreeReconciliationResult> {
    const records = withMappedErrorSync(() => this.registry.list())
      .filter(record => record.lifecycle !== 'removed')
    const groups = new Map<string, WorktreeRecord[]>()
    for (const record of records) {
      const group = groups.get(record.repository.commonDir) ?? []
      group.push(record)
      groups.set(record.repository.commonDir, group)
    }
    const recovery = new Map<string, WorktreeRecoveryReason>()
    const completedRemovals = new Map<string, string>()
    const recovered = new Map<string, 'ready' | 'orphaned'>()
    const orphaned = new Set<string>()
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
        const entry = byPath.get(checkout)
        if (repository !== undefined &&
          (repository.root !== checkout || repository.commonDir !== record.repository.commonDir)) {
          recovery.set(record.id, 'external-change')
          continue
        }
        if (repository === undefined) {
          if (entry === undefined && record.pendingOperation?.kind === 'remove') {
            const pathState = await checkoutPathState(checkout)
            if (pathState === 'absent') {
              completedRemovals.set(record.id, record.pendingOperation.id)
            } else {
              recovery.set(record.id, pathState === 'present' ? 'external-change' : 'inspection-failed')
            }
            continue
          }
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
        if (record.lifecycle === 'recovery-required' && record.pendingOperation?.kind !== 'remove') {
          recovered.set(record.id, options.orphanUnboundReady === true &&
            record.executionMode === 'worktree' && record.sessionId === undefined
            ? 'orphaned'
            : 'ready')
        }
        if (options.orphanUnboundReady === true && record.executionMode === 'worktree' &&
          record.lifecycle === 'ready' && record.sessionId === undefined) {
          orphaned.add(record.id)
        }
      }
    }

    for (const [id, operationId] of completedRemovals) {
      withMappedErrorSync(() => this.registry.markRemoved(id, operationId), true)
      recovery.delete(id)
    }
    if (recovery.size > 0) {
      withMappedErrorSync(() => this.registry.requireRecoveryBatch(
        [...recovery].map(([id, reason]) => ({ id, reason })),
      ), true)
    }
    if (recovered.size > 0) {
      withMappedErrorSync(() => this.registry.resolveRecoveryBatch(
        [...recovered].map(([id, lifecycle]) => ({ id, lifecycle })),
      ), true)
    }
    if (orphaned.size > 0) {
      withMappedErrorSync(() => this.registry.markOrphanedBatch([...orphaned]), true)
    }
    const snapshot = this.snapshot()
    return {
      repositories: groups.size,
      inspected: records.length,
      healthy,
      recovered: recovered.size,
      recoveryRequired: snapshot.worktrees.filter(worktree => worktree.lifecycle === 'recovery-required').length,
      orphaned: snapshot.worktrees.filter(worktree => worktree.lifecycle === 'orphaned').length,
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
