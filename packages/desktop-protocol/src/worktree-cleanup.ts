import type { WorktreeSummary } from './worktree.js'
import { parseWorktreeSummary } from './worktree.js'

const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024

export interface DesktopWorktreeCleanupPreviewInput {
  worktreeId: string
}

export interface WorktreeCleanupInspection {
  worktreePath: string
  head: string
  branch: string
  clean: true
  locked: true
}

export interface WorktreeCleanupPreview {
  previewId: string
  expiresAt: string
  worktree: WorktreeSummary
  inspection: WorktreeCleanupInspection
}

export interface DesktopWorktreeCleanupConfirmInput {
  previewId: string
  confirmed: true
}

export interface WorktreeCleanupResult {
  operationId: string
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

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !value.includes('\0') && !/[\r\n]/.test(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

export function parseDesktopWorktreeCleanupPreviewInput(
  value: unknown,
): DesktopWorktreeCleanupPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreeId']) || !isUuid(value.worktreeId)) return undefined
  return { worktreeId: value.worktreeId }
}

export function parseWorktreeCleanupInspection(value: unknown): WorktreeCleanupInspection | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreePath', 'head', 'branch', 'clean', 'locked']) ||
    !isBoundedText(value.worktreePath, MAX_PATH_LENGTH) || !isObjectId(value.head) ||
    !isBoundedText(value.branch, MAX_REF_LENGTH) || !value.branch.startsWith('refs/heads/') ||
    value.clean !== true || value.locked !== true) return undefined
  return {
    worktreePath: value.worktreePath,
    head: value.head,
    branch: value.branch,
    clean: true,
    locked: true,
  }
}

export function parseWorktreeCleanupPreview(value: unknown): WorktreeCleanupPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'expiresAt', 'worktree', 'inspection']) ||
    !isUuid(value.previewId) || !isIsoDate(value.expiresAt)) return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  const inspection = parseWorktreeCleanupInspection(value.inspection)
  if (worktree === undefined || inspection === undefined || worktree.executionMode !== 'worktree' ||
    worktree.worktreePath !== inspection.worktreePath || worktree.branch !== inspection.branch ||
    (worktree.lifecycle !== 'ready' && worktree.lifecycle !== 'orphaned')) return undefined
  return { previewId: value.previewId, expiresAt: value.expiresAt, worktree, inspection }
}

export function parseDesktopWorktreeCleanupConfirmInput(
  value: unknown,
): DesktopWorktreeCleanupConfirmInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'confirmed']) ||
    !isUuid(value.previewId) || value.confirmed !== true) return undefined
  return { previewId: value.previewId, confirmed: true }
}

export function parseWorktreeCleanupResult(value: unknown): WorktreeCleanupResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'worktree']) || !isUuid(value.operationId)) {
    return undefined
  }
  const worktree = parseWorktreeSummary(value.worktree)
  return worktree?.lifecycle === 'removed' ? { operationId: value.operationId, worktree } : undefined
}
