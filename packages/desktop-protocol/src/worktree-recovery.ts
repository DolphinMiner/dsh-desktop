import type { WorktreeSummary } from './worktree.js'
import { parseWorktreeSummary } from './worktree.js'
import type { WorktreeCleanupInspection } from './worktree-cleanup.js'
import { parseWorktreeCleanupInspection } from './worktree-cleanup.js'

export interface DesktopWorktreeRecoveryPreviewInput {
  worktreeId: string
  action: 'keep-interrupted-removal' | 'forget-missing'
}

export interface MissingWorktreeRecoveryInspection {
  repositoryRoot: string
  worktreePath: string
  branch: string
  worktreeMetadataAbsent: true
  checkoutPathAbsent: true
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

export type WorktreeRecoveryPreview = KeepInterruptedRemovalPreview | ForgetMissingWorktreePreview

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

export type WorktreeRecoveryResult = KeepInterruptedRemovalResult | ForgetMissingWorktreeResult

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

export function parseDesktopWorktreeRecoveryPreviewInput(
  value: unknown,
): DesktopWorktreeRecoveryPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreeId', 'action']) || !isUuid(value.worktreeId) ||
    (value.action !== 'keep-interrupted-removal' && value.action !== 'forget-missing')) return undefined
  return { worktreeId: value.worktreeId, action: value.action }
}

export function parseWorktreeRecoveryPreview(value: unknown): WorktreeRecoveryPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'previewId', 'expiresAt', 'action', 'worktree', 'inspection',
  ]) || !isUuid(value.previewId) || !isIsoDate(value.expiresAt) ||
    (value.action !== 'keep-interrupted-removal' && value.action !== 'forget-missing')) return undefined
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
    (value.action !== 'keep-interrupted-removal' && value.action !== 'forget-missing')) return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  if (worktree === undefined || worktree.executionMode !== 'worktree') return undefined
  if (value.action === 'keep-interrupted-removal' &&
    worktree.lifecycle !== 'ready' && worktree.lifecycle !== 'orphaned') return undefined
  if (value.action === 'forget-missing' && worktree.lifecycle !== 'removed') return undefined
  return {
    resolutionId: value.resolutionId,
    action: value.action,
    worktree,
  }
}
