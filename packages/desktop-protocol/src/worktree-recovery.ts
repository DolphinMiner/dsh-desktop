import type { WorktreeSummary } from './worktree.js'
import { parseWorktreeSummary } from './worktree.js'
import type { WorktreeCleanupInspection } from './worktree-cleanup.js'
import { parseWorktreeCleanupInspection } from './worktree-cleanup.js'
import type { GitRepositoryIdentity } from './git.js'
import { parseGitRepositoryIdentity } from './git.js'

export interface DesktopWorktreeRecoveryPreviewInput {
  worktreeId: string
  action: 'keep-interrupted-removal' | 'forget-missing' | 'restore-moved' | 'stop-tracking'
}

export interface MissingWorktreeRecoveryInspection {
  repositoryRoot: string
  worktreePath: string
  branch: string
  worktreeMetadataAbsent: true
  checkoutPathAbsent: true
}

export interface MovedWorktreeRecoveryInspection {
  repositoryRoot: string
  registeredPath: string
  current: WorktreeCleanupInspection
  registeredPathAbsent: true
}

export interface ExternalChangeWorktreeEntry {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  pruneReason?: string
}

export type ExternalChangeRepositoryObservation = {
  state: 'matching' | 'changed'
  identity: GitRepositoryIdentity
} | {
  state: 'not-a-repository'
}

export type ExternalChangeWorktreeRegistrationObservation = {
  state: 'matching' | 'changed'
  entry: ExternalChangeWorktreeEntry
} | {
  state: 'missing' | 'unavailable'
}

export interface ExternalChangeWorktreeRecoveryInspection {
  registeredRepository: GitRepositoryIdentity
  registeredPath: string
  registeredBranch: string
  checkoutPathPresent: true
  repositoryRootObservation: ExternalChangeRepositoryObservation
  checkoutObservation: ExternalChangeRepositoryObservation
  registrationObservation: ExternalChangeWorktreeRegistrationObservation
}

export interface KeepInterruptedRemovalPreview {
  previewId: string
  expiresAt: string
  action: 'keep-interrupted-removal'
  worktree: WorktreeSummary
  inspection: WorktreeCleanupInspection
}

export interface ForgetMissingWorktreePreview {
  previewId: string
  expiresAt: string
  action: 'forget-missing'
  worktree: WorktreeSummary
  inspection: MissingWorktreeRecoveryInspection
}

export interface RestoreMovedWorktreePreview {
  previewId: string
  expiresAt: string
  action: 'restore-moved'
  worktree: WorktreeSummary
  inspection: MovedWorktreeRecoveryInspection
}

export interface StopTrackingExternalChangePreview {
  previewId: string
  expiresAt: string
  action: 'stop-tracking'
  worktree: WorktreeSummary
  inspection: ExternalChangeWorktreeRecoveryInspection
}

export type WorktreeRecoveryPreview =
  | KeepInterruptedRemovalPreview
  | ForgetMissingWorktreePreview
  | RestoreMovedWorktreePreview
  | StopTrackingExternalChangePreview

export interface DesktopWorktreeRecoveryConfirmInput {
  previewId: string
  confirmed: true
}

export interface KeepInterruptedRemovalResult {
  resolutionId: string
  action: 'keep-interrupted-removal'
  worktree: WorktreeSummary
}

export interface ForgetMissingWorktreeResult {
  resolutionId: string
  action: 'forget-missing'
  worktree: WorktreeSummary
}

export interface RestoreMovedWorktreeResult {
  resolutionId: string
  action: 'restore-moved'
  worktree: WorktreeSummary
}

export interface StopTrackingExternalChangeResult {
  resolutionId: string
  action: 'stop-tracking'
  worktree: WorktreeSummary
}

export type WorktreeRecoveryResult =
  | KeepInterruptedRemovalResult
  | ForgetMissingWorktreeResult
  | RestoreMovedWorktreeResult
  | StopTrackingExternalChangeResult

const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function sameRepositoryIdentity(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function parseExactRepositoryIdentity(value: unknown): GitRepositoryIdentity | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['root', 'gitDir', 'commonDir'])) return undefined
  return parseGitRepositoryIdentity(value)
}

function parseExternalChangeRepositoryObservation(
  value: unknown,
): ExternalChangeRepositoryObservation | undefined {
  if (!isRecord(value) || (value.state !== 'matching' && value.state !== 'changed' &&
    value.state !== 'not-a-repository')) return undefined
  if (value.state === 'not-a-repository') {
    return hasOnlyKeys(value, ['state']) ? { state: value.state } : undefined
  }
  if (!hasOnlyKeys(value, ['state', 'identity'])) return undefined
  const identity = parseExactRepositoryIdentity(value.identity)
  return identity === undefined ? undefined : { state: value.state, identity }
}

function parseExternalChangeWorktreeEntry(value: unknown): ExternalChangeWorktreeEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'path', 'head', 'branch', 'detached', 'bare', 'locked', 'lockReason', 'prunable', 'pruneReason',
  ]) || !isBoundedString(value.path, MAX_PATH_LENGTH) ||
    (value.head !== undefined && (typeof value.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head))) ||
    (value.branch !== undefined && (!isBoundedString(value.branch, MAX_REF_LENGTH) || /[\r\n]/.test(value.branch))) ||
    typeof value.detached !== 'boolean' || typeof value.bare !== 'boolean' || typeof value.locked !== 'boolean' ||
    (value.lockReason !== undefined && !isBoundedString(value.lockReason, MAX_PATH_LENGTH)) ||
    typeof value.prunable !== 'boolean' ||
    (value.pruneReason !== undefined && !isBoundedString(value.pruneReason, MAX_PATH_LENGTH))) return undefined
  return {
    path: value.path,
    ...(value.head === undefined ? {} : { head: value.head }),
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    detached: value.detached,
    bare: value.bare,
    locked: value.locked,
    ...(value.lockReason === undefined ? {} : { lockReason: value.lockReason }),
    prunable: value.prunable,
    ...(value.pruneReason === undefined ? {} : { pruneReason: value.pruneReason }),
  }
}

function parseExternalChangeRegistrationObservation(
  value: unknown,
): ExternalChangeWorktreeRegistrationObservation | undefined {
  if (!isRecord(value) || (value.state !== 'matching' && value.state !== 'changed' &&
    value.state !== 'missing' && value.state !== 'unavailable')) return undefined
  if (value.state === 'missing' || value.state === 'unavailable') {
    return hasOnlyKeys(value, ['state']) ? { state: value.state } : undefined
  }
  if (!hasOnlyKeys(value, ['state', 'entry'])) return undefined
  const entry = parseExternalChangeWorktreeEntry(value.entry)
  return entry === undefined ? undefined : { state: value.state, entry }
}

export function parseMissingWorktreeRecoveryInspection(
  value: unknown,
): MissingWorktreeRecoveryInspection | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'repositoryRoot', 'worktreePath', 'branch', 'worktreeMetadataAbsent', 'checkoutPathAbsent',
  ]) || !isBoundedString(value.repositoryRoot, MAX_PATH_LENGTH) ||
    !isBoundedString(value.worktreePath, MAX_PATH_LENGTH) ||
    !isBoundedString(value.branch, MAX_REF_LENGTH) || /[\r\n]/.test(value.branch) ||
    value.worktreeMetadataAbsent !== true || value.checkoutPathAbsent !== true) return undefined
  return {
    repositoryRoot: value.repositoryRoot,
    worktreePath: value.worktreePath,
    branch: value.branch,
    worktreeMetadataAbsent: true,
    checkoutPathAbsent: true,
  }
}

export function parseMovedWorktreeRecoveryInspection(
  value: unknown,
): MovedWorktreeRecoveryInspection | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'repositoryRoot', 'registeredPath', 'current', 'registeredPathAbsent',
  ]) || !isBoundedString(value.repositoryRoot, MAX_PATH_LENGTH) ||
    !isBoundedString(value.registeredPath, MAX_PATH_LENGTH) || value.registeredPathAbsent !== true) return undefined
  const current = parseWorktreeCleanupInspection(value.current)
  if (current === undefined || current.worktreePath === value.registeredPath) return undefined
  return {
    repositoryRoot: value.repositoryRoot,
    registeredPath: value.registeredPath,
    current,
    registeredPathAbsent: true,
  }
}

export function parseExternalChangeWorktreeRecoveryInspection(
  value: unknown,
): ExternalChangeWorktreeRecoveryInspection | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'registeredRepository', 'registeredPath', 'registeredBranch', 'checkoutPathPresent',
    'repositoryRootObservation', 'checkoutObservation', 'registrationObservation',
  ]) || !isBoundedString(value.registeredPath, MAX_PATH_LENGTH) ||
    !isBoundedString(value.registeredBranch, MAX_REF_LENGTH) || /[\r\n]/.test(value.registeredBranch) ||
    value.checkoutPathPresent !== true) return undefined
  const registeredRepository = parseExactRepositoryIdentity(value.registeredRepository)
  const repositoryRootObservation = parseExternalChangeRepositoryObservation(value.repositoryRootObservation)
  const checkoutObservation = parseExternalChangeRepositoryObservation(value.checkoutObservation)
  const registrationObservation = parseExternalChangeRegistrationObservation(value.registrationObservation)
  if (registeredRepository === undefined || repositoryRootObservation === undefined ||
    checkoutObservation === undefined || registrationObservation === undefined) return undefined

  const repositoryMatches = repositoryRootObservation.state === 'matching'
    ? sameRepositoryIdentity(repositoryRootObservation.identity, registeredRepository)
    : repositoryRootObservation.state === 'changed'
      ? !sameRepositoryIdentity(repositoryRootObservation.identity, registeredRepository)
      : true
  const checkoutIdentityMatches = checkoutObservation.state === 'matching'
    ? checkoutObservation.identity.root === value.registeredPath &&
      checkoutObservation.identity.commonDir === registeredRepository.commonDir
    : checkoutObservation.state === 'changed'
      ? checkoutObservation.identity.root !== value.registeredPath ||
        checkoutObservation.identity.commonDir !== registeredRepository.commonDir
      : true
  if (!repositoryMatches || !checkoutIdentityMatches) return undefined

  if (registrationObservation.state === 'matching' || registrationObservation.state === 'changed') {
    const entryMatches = registrationObservation.entry.path === value.registeredPath &&
      registrationObservation.entry.branch === value.registeredBranch &&
      !registrationObservation.entry.detached && !registrationObservation.entry.bare &&
      !registrationObservation.entry.prunable
    if ((registrationObservation.state === 'matching') !== entryMatches) return undefined
  }
  if ((repositoryRootObservation.state === 'matching') ===
    (registrationObservation.state === 'unavailable')) return undefined
  if (repositoryRootObservation.state === 'matching' && checkoutObservation.state === 'matching' &&
    registrationObservation.state === 'matching') return undefined

  return {
    registeredRepository,
    registeredPath: value.registeredPath,
    registeredBranch: value.registeredBranch,
    checkoutPathPresent: true,
    repositoryRootObservation,
    checkoutObservation,
    registrationObservation,
  }
}

export function parseDesktopWorktreeRecoveryPreviewInput(
  value: unknown,
): DesktopWorktreeRecoveryPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreeId', 'action']) || !isUuid(value.worktreeId) ||
    (value.action !== 'keep-interrupted-removal' && value.action !== 'forget-missing' &&
      value.action !== 'restore-moved' && value.action !== 'stop-tracking')) return undefined
  return { worktreeId: value.worktreeId, action: value.action }
}

export function parseWorktreeRecoveryPreview(value: unknown): WorktreeRecoveryPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'previewId', 'expiresAt', 'action', 'worktree', 'inspection',
  ]) || !isUuid(value.previewId) || !isIsoDate(value.expiresAt) ||
    (value.action !== 'keep-interrupted-removal' && value.action !== 'forget-missing' &&
      value.action !== 'restore-moved' && value.action !== 'stop-tracking')) return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  if (worktree === undefined || worktree.executionMode !== 'worktree' ||
    worktree.lifecycle !== 'recovery-required') return undefined
  if (value.action === 'keep-interrupted-removal') {
    const inspection = parseWorktreeCleanupInspection(value.inspection)
    if (inspection === undefined || worktree.recoveryReason !== 'interrupted-remove' ||
      worktree.worktreePath !== inspection.worktreePath || worktree.branch !== inspection.branch) return undefined
    return {
      previewId: value.previewId,
      expiresAt: value.expiresAt,
      action: value.action,
      worktree,
      inspection,
    }
  }
  if (value.action === 'forget-missing') {
    const inspection = parseMissingWorktreeRecoveryInspection(value.inspection)
    if (inspection === undefined || worktree.recoveryReason !== 'missing' ||
      worktree.repositoryRoot !== inspection.repositoryRoot ||
      worktree.worktreePath !== inspection.worktreePath || worktree.branch !== inspection.branch) return undefined
    return {
      previewId: value.previewId,
      expiresAt: value.expiresAt,
      action: value.action,
      worktree,
      inspection,
    }
  }
  if (value.action === 'restore-moved') {
    const inspection = parseMovedWorktreeRecoveryInspection(value.inspection)
    if (inspection === undefined || worktree.recoveryReason !== 'moved' ||
      worktree.repositoryRoot !== inspection.repositoryRoot || worktree.worktreePath !== inspection.registeredPath ||
      worktree.branch !== inspection.current.branch) return undefined
    return { previewId: value.previewId, expiresAt: value.expiresAt, action: value.action, worktree, inspection }
  }
  const inspection = parseExternalChangeWorktreeRecoveryInspection(value.inspection)
  if (inspection === undefined || worktree.recoveryReason !== 'external-change' ||
    worktree.repositoryRoot !== inspection.registeredRepository.root ||
    worktree.worktreePath !== inspection.registeredPath || worktree.branch !== inspection.registeredBranch) {
    return undefined
  }
  return { previewId: value.previewId, expiresAt: value.expiresAt, action: value.action, worktree, inspection }
}

export function parseDesktopWorktreeRecoveryConfirmInput(
  value: unknown,
): DesktopWorktreeRecoveryConfirmInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'confirmed']) ||
    !isUuid(value.previewId) || value.confirmed !== true) return undefined
  return { previewId: value.previewId, confirmed: true }
}

export function parseWorktreeRecoveryResult(value: unknown): WorktreeRecoveryResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['resolutionId', 'action', 'worktree']) ||
    !isUuid(value.resolutionId) ||
    (value.action !== 'keep-interrupted-removal' && value.action !== 'forget-missing' &&
      value.action !== 'restore-moved' && value.action !== 'stop-tracking')) return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  if (worktree === undefined || worktree.executionMode !== 'worktree') return undefined
  if ((value.action === 'keep-interrupted-removal' || value.action === 'restore-moved') &&
    worktree.lifecycle !== 'ready' && worktree.lifecycle !== 'orphaned') return undefined
  if ((value.action === 'forget-missing' || value.action === 'stop-tracking') &&
    worktree.lifecycle !== 'removed') return undefined
  return {
    resolutionId: value.resolutionId,
    action: value.action,
    worktree,
  }
}
