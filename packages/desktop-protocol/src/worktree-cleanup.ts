import type { WorktreeSummary } from './worktree.js'
import { parseWorktreeSummary } from './worktree.js'
import type { GitStatusEntry } from './git.js'
import { parseGitStatusEntry } from './git.js'

const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024
const MAX_CHANGES = 20_000

export interface DesktopWorktreeCleanupPreviewInput {
  worktreeId: string
}

interface WorktreeCleanupInspectionBase {
  worktreePath: string
  head: string
  branch: string
  locked: true
}

export interface CleanWorktreeCleanupInspection extends WorktreeCleanupInspectionBase {
  clean: true
  changes: []
}

export interface DirtyWorktreeCleanupInspection extends WorktreeCleanupInspectionBase {
  clean: false
  changes: GitStatusEntry[]
}

export type WorktreeCleanupInspection =
  | CleanWorktreeCleanupInspection
  | DirtyWorktreeCleanupInspection

export interface RemovableWorktreeCleanupPreview {
  canRemove: true
  previewId: string
  expiresAt: string
  worktree: WorktreeSummary
  inspection: CleanWorktreeCleanupInspection
}

export interface BlockedWorktreeCleanupPreview {
  canRemove: false
  worktree: WorktreeSummary
  inspection: DirtyWorktreeCleanupInspection
}

export type WorktreeCleanupPreview =
  | RemovableWorktreeCleanupPreview
  | BlockedWorktreeCleanupPreview

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
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreePath', 'head', 'branch', 'clean', 'locked', 'changes']) ||
    !isBoundedText(value.worktreePath, MAX_PATH_LENGTH) || !isObjectId(value.head) ||
    !isBoundedText(value.branch, MAX_REF_LENGTH) || !value.branch.startsWith('refs/heads/') ||
    typeof value.clean !== 'boolean' || value.locked !== true || !Array.isArray(value.changes) ||
    value.changes.length > MAX_CHANGES) return undefined
  const changes = value.changes.map(parseGitStatusEntry)
  if (changes.some(change => change === undefined) || value.clean !== (changes.length === 0) ||
    new Set((changes as GitStatusEntry[]).map(change => change.path)).size !== changes.length) return undefined
  if (value.clean) {
    return {
      worktreePath: value.worktreePath,
      head: value.head,
      branch: value.branch,
      clean: true,
      locked: true,
      changes: [],
    }
  }
  return {
    worktreePath: value.worktreePath,
    head: value.head,
    branch: value.branch,
    clean: false,
    locked: true,
    changes: changes as GitStatusEntry[],
  }
}

export function parseWorktreeCleanupPreview(value: unknown): WorktreeCleanupPreview | undefined {
  if (!isRecord(value) || typeof value.canRemove !== 'boolean') return undefined
  const worktree = parseWorktreeSummary(value.worktree)
  const inspection = parseWorktreeCleanupInspection(value.inspection)
  if (worktree === undefined || inspection === undefined || worktree.executionMode !== 'worktree' ||
    worktree.worktreePath !== inspection.worktreePath || worktree.branch !== inspection.branch ||
    (worktree.lifecycle !== 'ready' && worktree.lifecycle !== 'orphaned')) return undefined
  if (!value.canRemove) {
    if (!hasOnlyKeys(value, ['canRemove', 'worktree', 'inspection']) || inspection.clean) return undefined
    return { canRemove: false, worktree, inspection }
  }
  if (!hasOnlyKeys(value, ['canRemove', 'previewId', 'expiresAt', 'worktree', 'inspection']) ||
    !isUuid(value.previewId) || !isIsoDate(value.expiresAt) || !inspection.clean) return undefined
  return {
    canRemove: true,
    previewId: value.previewId,
    expiresAt: value.expiresAt,
    worktree,
    inspection,
  }
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
