import type { WorktreeSummary } from './worktree.js'
import { parseWorktreeSummary } from './worktree.js'
import type { WorktreeCleanupInspection } from './worktree-cleanup.js'
import { parseWorktreeCleanupInspection } from './worktree-cleanup.js'

export interface DesktopWorktreeRecoveryPreviewInput {
  worktreeId: string
  action: 'keep-interrupted-removal'
}

export interface WorktreeRecoveryPreview {
  previewId: string
  expiresAt: string
  action: 'keep-interrupted-removal'
  worktree: WorktreeSummary
  inspection: WorktreeCleanupInspection
}

export interface DesktopWorktreeRecoveryConfirmInput {
  previewId: string
  confirmed: true
}

export interface WorktreeRecoveryResult {
  resolutionId: string
  action: 'keep-interrupted-removal'
  worktree: WorktreeSummary
}

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

export function parseDesktopWorktreeRecoveryPreviewInput(
  value: unknown,
): DesktopWorktreeRecoveryPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreeId', 'action']) || !isUuid(value.worktreeId) ||
    value.action !== 'keep-interrupted-removal') return undefined
  return { worktreeId: value.worktreeId, action: 'keep-interrupted-removal' }
}

export function parseWorktreeRecoveryPreview(value: unknown): WorktreeRecoveryPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'previewId', 'expiresAt', 'action', 'worktree', 'inspection',
  ]) || !isUuid(value.previewId) || !isIsoDate(value.expiresAt) ||
    value.action !== 'keep-interrupted-removal') return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  const inspection = parseWorktreeCleanupInspection(value.inspection)
  if (worktree === undefined || inspection === undefined || worktree.executionMode !== 'worktree' ||
    worktree.lifecycle !== 'recovery-required' || worktree.recoveryReason !== 'interrupted-remove' ||
    worktree.worktreePath !== inspection.worktreePath || worktree.branch !== inspection.branch) return undefined
  return {
    previewId: value.previewId,
    expiresAt: value.expiresAt,
    action: 'keep-interrupted-removal',
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
    !isUuid(value.resolutionId) || value.action !== 'keep-interrupted-removal') return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  if (worktree === undefined || worktree.executionMode !== 'worktree' ||
    (worktree.lifecycle !== 'ready' && worktree.lifecycle !== 'orphaned')) return undefined
  return {
    resolutionId: value.resolutionId,
    action: 'keep-interrupted-removal',
    worktree,
  }
}
