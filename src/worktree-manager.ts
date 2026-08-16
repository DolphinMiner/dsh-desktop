import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  DesktopProtocolError,
  ExternalChangeRepositoryObservation,
  ExternalChangeWorktreeEntry,
  ExternalChangeWorktreeRecoveryInspection,
  ExternalChangeWorktreeRegistrationObservation,
  GitRepositoryIdentity,
  MissingWorktreeRecoveryInspection,
  MovedWorktreeRecoveryInspection,
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
  GitMoveWorktreeInput,
  GitRemoveWorktreeInput,
  GitServiceError,
  GitTransferWorktreeHandoffInput,
  GitWorktreeHandoffOutcome,
  GitWorktreeHandoffInspection,
  GitWorktreeHandoffTransferResult,
  GitWorktreeMoveOutcome,
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
  moveWorktree(
    input: GitMoveWorktreeInput,
    signal?: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<void>
  inspectWorktreeMoveOutcome(
    input: GitMoveWorktreeInput,
    signal?: AbortSignal,
  ): Promise<GitWorktreeMoveOutcome>
}

export interface ProvisionWorktreeInput {
  operationId: string
  requestedBySessionId: string
  workspaceRoot: string
  baseRef: string
}

export interface ProvisionAutomationWorktreeInput extends ProvisionWorktreeInput {
  repository: GitRepositoryIdentity
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

export interface MovedWorktreeRecoveryState {
  record: WorktreeRecord
  inspection: MovedWorktreeRecoveryInspection
}

export interface ExternalChangeWorktreeRecoveryState {
  record: WorktreeRecord
  inspection: ExternalChangeWorktreeRecoveryInspection
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

function sameMovedWorktreeInspection(
  left: MovedWorktreeRecoveryInspection,
  right: MovedWorktreeRecoveryInspection,
): boolean {
  return left.repositoryRoot === right.repositoryRoot && left.registeredPath === right.registeredPath &&
    left.registeredPathAbsent === right.registeredPathAbsent &&
    sameCleanupInspection(left.current, right.current)
}

function sameRepositoryIdentity(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function sameRepositoryObservation(
  left: ExternalChangeRepositoryObservation,
  right: ExternalChangeRepositoryObservation,
): boolean {
  if (left.state !== right.state) return false
  if (left.state === 'not-a-repository' || right.state === 'not-a-repository') return true
  return sameRepositoryIdentity(left.identity, right.identity)
}

function sameExternalChangeEntry(left: ExternalChangeWorktreeEntry, right: ExternalChangeWorktreeEntry): boolean {
  return left.path === right.path && left.head === right.head && left.branch === right.branch &&
    left.detached === right.detached && left.bare === right.bare && left.locked === right.locked &&
    left.lockReason === right.lockReason && left.prunable === right.prunable &&
    left.pruneReason === right.pruneReason
}

function sameRegistrationObservation(
  left: ExternalChangeWorktreeRegistrationObservation,
  right: ExternalChangeWorktreeRegistrationObservation,
): boolean {
  if (left.state !== right.state) return false
  if ((left.state === 'matching' || left.state === 'changed') &&
    (right.state === 'matching' || right.state === 'changed')) {
    return sameExternalChangeEntry(left.entry, right.entry)
  }
  return true
}

function sameExternalChangeInspection(
  left: ExternalChangeWorktreeRecoveryInspection,
  right: ExternalChangeWorktreeRecoveryInspection,
): boolean {
  return sameRepositoryIdentity(left.registeredRepository, right.registeredRepository) &&
    left.registeredPath === right.registeredPath && left.registeredBranch === right.registeredBranch &&
    left.checkoutPathPresent === right.checkoutPathPresent &&
    sameRepositoryObservation(left.repositoryRootObservation, right.repositoryRootObservation) &&
    sameRepositoryObservation(left.checkoutObservation, right.checkoutObservation) &&
    sameRegistrationObservation(left.registrationObservation, right.registrationObservation)
}

function externalChangeEntry(entry: GitWorktreeEntry): ExternalChangeWorktreeEntry {
  return {
    path: entry.path,
    ...(entry.head === undefined ? {} : { head: entry.head }),
    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
    detached: entry.detached,
    bare: entry.bare,
    locked: entry.locked,
    ...(entry.lockReason === undefined ? {} : { lockReason: entry.lockReason }),
    prunable: entry.prunable,
    ...(entry.pruneReason === undefined ? {} : { pruneReason: entry.pruneReason }),
  }
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

  get(id: string): WorktreeRecord | undefined {
    if (!isBoundedString(id, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The worktree identifier is invalid.')
    }
    return withMappedErrorSync(() => this.registry.get(id))
  }

  getByStopTrackingOperation(operationId: string): WorktreeRecord | undefined {
    if (!isBoundedString(operationId, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The stop-tracking resolution identifier is invalid.')
    }
    return withMappedErrorSync(() => this.registry.getByStopTrackingOperation(operationId))
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

  async inspectMovedWorktree(
    id: string,
    signal: AbortSignal,
  ): Promise<MovedWorktreeRecoveryState> {
    const record = this.get(id)
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    if (record.executionMode !== 'worktree' || record.worktreePath === undefined || record.branch === undefined ||
      record.lifecycle !== 'recovery-required' || record.recoveryReason !== 'moved' ||
      record.pendingOperation !== undefined) {
      throw new WorktreeManagerError('CONFLICT', 'This worktree does not have a moved checkout to restore.')
    }
    const repository = await withMappedError(() => this.git.discoverRepository(record.repository.root, signal), true)
    if (repository.root !== record.repository.root || repository.gitDir !== record.repository.gitDir ||
      repository.commonDir !== record.repository.commonDir) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The original repository identity changed. Recheck the worktree before restoring it.',
        true,
      )
    }
    const entries = await withMappedError(() => this.git.listWorktrees(repository.root, signal), true)
    const branchEntries = entries.filter(entry => entry.branch === record.branch)
    if (branchEntries.length !== 1 || branchEntries[0]!.path === record.worktreePath ||
      entries.some(entry => entry.path === record.worktreePath)) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'Git no longer reports one exact moved checkout for the managed branch.',
        true,
      )
    }
    const pathStatus = await checkoutPathState(record.worktreePath)
    if (pathStatus === 'present') {
      throw new WorktreeManagerError('CONFLICT', 'The registered worktree path is no longer empty.', true)
    }
    if (pathStatus === 'unknown') {
      throw new WorktreeManagerError(
        'DESKTOP_UNAVAILABLE',
        'The registered worktree path could not be verified as absent.',
        true,
      )
    }
    const lockReason = expectedLockReason(record)
    if (lockReason === undefined) {
      throw new WorktreeManagerError('CONFLICT', 'The managed worktree lock identity is invalid.', true)
    }
    const current = await withMappedError(() => this.git.inspectWorktreeForRemoval({
      repositoryRoot: repository.root,
      worktreePath: branchEntries[0]!.path,
      branch: record.branch!,
      lockReason,
    }, signal), true)
    return {
      record,
      inspection: {
        repositoryRoot: repository.root,
        registeredPath: record.worktreePath,
        current,
        registeredPathAbsent: true,
      },
    }
  }

  async restoreMovedWorktree(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    const current = await this.inspectMovedWorktree(id, signal)
    if (!sameMovedWorktreeInspection(current.inspection, expected)) {
      throw new WorktreeManagerError('CONFLICT', 'The moved checkout changed after approval. Inspect it again.')
    }
    const lockReason = expectedLockReason(current.record)!
    let dispatched = false
    let dispatchBoundaryError: unknown
    try {
      await this.git.moveWorktree({
        repository: current.record.repository,
        source: current.inspection.current,
        destinationPath: current.inspection.registeredPath,
        lockReason,
      }, signal, () => {
        try {
          beforeDispatch?.(current.record)
        } catch (error) {
          dispatchBoundaryError = error
          throw error
        }
        dispatched = true
      })
    } catch (error) {
      if (dispatchBoundaryError !== undefined) throw dispatchBoundaryError
      mapError(error, dispatched)
    }
    return withMappedErrorSync(() =>
      this.registry.resolveRecovery(id, current.record.sessionId === undefined ? 'orphaned' : 'ready'), true)
  }

  async inspectMovedWorktreeOutcome(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    signal: AbortSignal,
  ): Promise<GitWorktreeMoveOutcome> {
    const record = this.get(id)
    if (record === undefined || record.executionMode !== 'worktree' || record.worktreePath === undefined ||
      record.branch === undefined || record.repository.root !== expected.repositoryRoot ||
      record.worktreePath !== expected.registeredPath || record.branch !== expected.current.branch) {
      return 'ambiguous'
    }
    const lockReason = expectedLockReason(record)
    if (lockReason === undefined) return 'ambiguous'
    return withMappedError(() => this.git.inspectWorktreeMoveOutcome({
      repository: record.repository,
      source: expected.current,
      destinationPath: expected.registeredPath,
      lockReason,
    }, signal), true)
  }

  async completeMovedWorktreeRecovery(
    id: string,
    expected: MovedWorktreeRecoveryInspection,
    signal: AbortSignal,
  ): Promise<WorktreeRecord> {
    const outcome = await this.inspectMovedWorktreeOutcome(id, expected, signal)
    if (outcome !== 'completed') {
      throw new WorktreeManagerError('CONFLICT', 'The moved checkout has not reached its exact registered path.')
    }
    const record = this.get(id)
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    if (record.lifecycle === 'ready' || record.lifecycle === 'orphaned') return record
    if (record.lifecycle !== 'recovery-required' || record.recoveryReason !== 'moved' ||
      record.pendingOperation !== undefined) {
      throw new WorktreeManagerError('CONFLICT', 'The moved worktree recovery state changed before completion.')
    }
    return withMappedErrorSync(() =>
      this.registry.resolveRecovery(id, record.sessionId === undefined ? 'orphaned' : 'ready'), true)
  }

  async inspectExternalChangeWorktree(
    id: string,
    signal: AbortSignal,
  ): Promise<ExternalChangeWorktreeRecoveryState> {
    const record = this.get(id)
    if (record === undefined) throw new WorktreeManagerError('NOT_FOUND', 'The managed worktree was not found.')
    if (record.executionMode !== 'worktree' || record.worktreePath === undefined || record.branch === undefined ||
      record.lifecycle !== 'recovery-required' || record.recoveryReason !== 'external-change' ||
      record.pendingOperation !== undefined) {
      throw new WorktreeManagerError('CONFLICT', 'This worktree does not have an identity change to stop tracking.')
    }
    const pathState = await checkoutPathState(record.worktreePath)
    if (pathState === 'absent') {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The registered checkout path is now absent. Recheck it before choosing a recovery action.',
        true,
      )
    }
    if (pathState === 'unknown') {
      throw new WorktreeManagerError(
        'DESKTOP_UNAVAILABLE',
        'The registered checkout path could not be inspected.',
        true,
      )
    }

    const [repositoryRootObservation, checkoutObservation] = await Promise.all([
      this.observeRepositoryIdentity(
        record.repository.root,
        identity => sameRepositoryIdentity(identity, record.repository),
        signal,
      ),
      this.observeRepositoryIdentity(
        record.worktreePath,
        identity => identity.root === record.worktreePath &&
          identity.commonDir === record.repository.commonDir,
        signal,
      ),
    ])

    let registrationObservation: ExternalChangeWorktreeRegistrationObservation = { state: 'unavailable' }
    if (repositoryRootObservation.state === 'matching') {
      const entries = await withMappedError(() =>
        this.git.listWorktrees(repositoryRootObservation.identity.root, signal), true)
      const pathEntries = entries.filter(entry => entry.path === record.worktreePath)
      if (pathEntries.length > 1) {
        throw new WorktreeManagerError('CONFLICT', 'Git returned conflicting registrations for this checkout.', true)
      }
      const entry = pathEntries[0]
      if (entry === undefined) {
        if (entries.some(candidate => candidate.branch === record.branch)) {
          throw new WorktreeManagerError(
            'CONFLICT',
            'The managed branch is now registered at another path. Recheck it as a moved checkout.',
            true,
          )
        }
        registrationObservation = { state: 'missing' }
      } else {
        if (entry.prunable) {
          throw new WorktreeManagerError(
            'CONFLICT',
            'Git now marks this checkout registration as prunable. Recheck it before resolving recovery.',
            true,
          )
        }
        const summarized = externalChangeEntry(entry)
        registrationObservation = {
          state: !entry.bare && !entry.detached && entry.branch === record.branch ? 'matching' : 'changed',
          entry: summarized,
        }
      }
    }

    if (repositoryRootObservation.state === 'matching' && checkoutObservation.state === 'matching' &&
      registrationObservation.state === 'matching') {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The registered repository and checkout identity now match. Recheck instead of stopping tracking.',
      )
    }
    return {
      record,
      inspection: {
        registeredRepository: { ...record.repository },
        registeredPath: record.worktreePath,
        registeredBranch: record.branch,
        checkoutPathPresent: true,
        repositoryRootObservation,
        checkoutObservation,
        registrationObservation,
      },
    }
  }

  async stopTrackingExternalChange(
    id: string,
    resolutionOperationId: string,
    expected: ExternalChangeWorktreeRecoveryInspection,
    signal: AbortSignal,
    beforeCommit?: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> {
    if (!isBoundedString(resolutionOperationId, MAX_ID_LENGTH)) {
      throw new WorktreeManagerError('BAD_MESSAGE', 'The stop-tracking resolution identifier is invalid.')
    }
    const current = await this.inspectExternalChangeWorktree(id, signal)
    if (!sameExternalChangeInspection(current.inspection, expected)) {
      throw new WorktreeManagerError(
        'CONFLICT',
        'The repository or checkout identity changed after approval. Inspect it again.',
      )
    }
    beforeCommit?.(current.record)
    return withMappedErrorSync(() =>
      this.registry.stopTrackingExternalChange(id, resolutionOperationId), true)
  }

  private async observeRepositoryIdentity(
    path: string,
    matches: (identity: GitRepositoryIdentity) => boolean,
    signal: AbortSignal,
  ): Promise<ExternalChangeRepositoryObservation> {
    try {
      const identity = await this.git.discoverRepository(path, signal)
      return { state: matches(identity) ? 'matching' : 'changed', identity }
    } catch (error) {
      throwIfCancelled(error)
      if (isUnavailableCheckout(error)) return { state: 'not-a-repository' }
      mapError(error, true)
    }
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
    return this.provisionVerified(input, repository, signal, () => {
      this.authorize(input.requestedBySessionId, input.workspaceRoot, signal)
    })
  }

  async provisionAutomation(
    input: ProvisionAutomationWorktreeInput,
    signal: AbortSignal,
  ): Promise<ProvisionWorktreeResult> {
    validateInput(input)
    const repository = await withMappedError(() =>
      this.git.discoverRepository(input.workspaceRoot, signal), true)
    if (!sameRepositoryIdentity(repository, input.repository)) {
      throw new WorktreeManagerError(
        'TARGET_CHANGED',
        'The automation repository identity changed before worktree creation.',
        true,
      )
    }
    return this.provisionVerified(input, repository, signal, async () => {
      const observed = await withMappedError(() =>
        this.git.discoverRepository(input.workspaceRoot, signal), true)
      if (!sameRepositoryIdentity(observed, input.repository)) {
        throw new WorktreeManagerError(
          'TARGET_CHANGED',
          'The automation repository identity changed during worktree creation.',
          true,
        )
      }
    })
  }

  private async provisionVerified(
    input: ProvisionWorktreeInput,
    repository: GitRepositoryIdentity,
    signal: AbortSignal,
    assertAuthority: () => void | Promise<void>,
  ): Promise<ProvisionWorktreeResult> {
    const baseCommit = await withMappedError(() =>
      this.git.resolveCommit(repository.root, input.baseRef, signal))
    const root = await withMappedError(async () => {
      await mkdir(this.managedRoot, { recursive: true, mode: 0o700 })
      return realpath(this.managedRoot)
    })
    await assertAuthority()

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
        await assertAuthority()
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
    await assertAuthority()
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
