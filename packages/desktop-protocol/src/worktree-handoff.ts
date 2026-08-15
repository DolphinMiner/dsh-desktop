import type { GitReviewFileStatus } from './git.js'
import type { WorktreeSummary } from './worktree.js'
import { parseWorktreeSummary } from './worktree.js'

const MAX_PATH_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024
const MAX_FILES = 10_000
const MAX_PATCH_LENGTH = 8 * 1_024 * 1_024

export type WorktreeHandoffDirection = 'local-to-worktree' | 'worktree-to-local'

export type WorktreeHandoffBlocker =
  | 'source-detached'
  | 'source-conflicts'
  | 'source-diverged'
  | 'destination-detached'
  | 'destination-head-changed'
  | 'destination-dirty'
  | 'destination-collision'
  | 'no-changes'

export interface DesktopWorktreeHandoffPreflightInput {
  worktreeId: string
  direction: WorktreeHandoffDirection
}

export interface WorktreeHandoffEndpoint {
  kind: 'local' | 'worktree'
  path: string
  branch?: string
  head: string
  clean: boolean
}

export interface WorktreeHandoffFile {
  status: GitReviewFileStatus
  path: string
  originalPath?: string
  patchAvailable: boolean
}

export interface WorktreeHandoffPreflight {
  direction: WorktreeHandoffDirection
  worktree: WorktreeSummary
  baseCommit: string
  sourceTree?: string
  source: WorktreeHandoffEndpoint
  destination: WorktreeHandoffEndpoint
  files: WorktreeHandoffFile[]
  patch: string
  blockers: WorktreeHandoffBlocker[]
  canTransfer: boolean
}

export interface WorktreeHandoffPreview {
  previewId: string
  expiresAt: string
  preflight: WorktreeHandoffPreflight
}

export interface DesktopWorktreeHandoffConfirmInput {
  previewId: string
  confirmed: true
}

export interface WorktreeHandoffResult {
  operationId: string
  direction: WorktreeHandoffDirection
  sourceTree: string
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
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

function isDirection(value: unknown): value is WorktreeHandoffDirection {
  return value === 'local-to-worktree' || value === 'worktree-to-local'
}

function isBlocker(value: unknown): value is WorktreeHandoffBlocker {
  return value === 'source-detached' || value === 'source-conflicts' || value === 'source-diverged' ||
    value === 'destination-detached' || value === 'destination-head-changed' || value === 'destination-dirty' ||
    value === 'destination-collision' || value === 'no-changes'
}

function isFileStatus(value: unknown): value is GitReviewFileStatus {
  return value === 'added' || value === 'modified' || value === 'deleted' || value === 'renamed' ||
    value === 'copied' || value === 'type-changed' || value === 'unmerged' || value === 'untracked'
}

function parseEndpoint(value: unknown): WorktreeHandoffEndpoint | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'path', 'branch', 'head', 'clean']) ||
    (value.kind !== 'local' && value.kind !== 'worktree') || !isBoundedText(value.path, MAX_PATH_LENGTH) ||
    !isObjectId(value.head) || typeof value.clean !== 'boolean' ||
    (value.branch !== undefined && (!isBoundedText(value.branch, MAX_REF_LENGTH) || /[\r\n]/.test(value.branch)))) {
    return undefined
  }
  return {
    kind: value.kind,
    path: value.path,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    head: value.head,
    clean: value.clean,
  }
}

function parseFile(value: unknown): WorktreeHandoffFile | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'path', 'originalPath', 'patchAvailable']) ||
    !isFileStatus(value.status) || !isBoundedText(value.path, MAX_PATH_LENGTH) ||
    typeof value.patchAvailable !== 'boolean' ||
    (value.originalPath !== undefined && !isBoundedText(value.originalPath, MAX_PATH_LENGTH)) ||
    ((value.status === 'renamed' || value.status === 'copied') !== (value.originalPath !== undefined)) ||
    (value.status === 'untracked' && value.patchAvailable)) return undefined
  return {
    status: value.status,
    path: value.path,
    ...(value.originalPath === undefined ? {} : { originalPath: value.originalPath }),
    patchAvailable: value.patchAvailable,
  }
}

export function parseDesktopWorktreeHandoffPreflightInput(
  value: unknown,
): DesktopWorktreeHandoffPreflightInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['worktreeId', 'direction']) ||
    !isUuid(value.worktreeId) || !isDirection(value.direction)) return undefined
  return { worktreeId: value.worktreeId, direction: value.direction }
}

export function parseWorktreeHandoffPreflight(value: unknown): WorktreeHandoffPreflight | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'direction', 'worktree', 'baseCommit', 'sourceTree', 'source', 'destination', 'files', 'patch', 'blockers',
    'canTransfer',
  ]) || !isDirection(value.direction) || !isObjectId(value.baseCommit) ||
    (value.sourceTree !== undefined && !isObjectId(value.sourceTree)) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_FILES || typeof value.patch !== 'string' || value.patch.length > MAX_PATCH_LENGTH ||
    value.patch.includes('\0') || !Array.isArray(value.blockers) || typeof value.canTransfer !== 'boolean') {
    return undefined
  }
  const worktree = parseWorktreeSummary(value.worktree)
  const source = parseEndpoint(value.source)
  const destination = parseEndpoint(value.destination)
  const files = value.files.map(parseFile)
  const blockers = value.blockers.filter(isBlocker)
  if (worktree === undefined || worktree.executionMode !== 'worktree' || worktree.worktreePath === undefined ||
    (worktree.lifecycle !== 'ready' && worktree.lifecycle !== 'orphaned') || source === undefined ||
    destination === undefined || files.some(file => file === undefined) || blockers.length !== value.blockers.length ||
    new Set((files as WorktreeHandoffFile[]).map(file => file.path)).size !== files.length ||
    new Set(blockers).size !== blockers.length || value.canTransfer !== (blockers.length === 0) ||
    (value.canTransfer && value.sourceTree === undefined) ||
    (value.direction === 'local-to-worktree' &&
      (source.kind !== 'local' || source.path !== worktree.repositoryRoot || destination.kind !== 'worktree' ||
        destination.path !== worktree.worktreePath)) ||
    (value.direction === 'worktree-to-local' &&
      (source.kind !== 'worktree' || source.path !== worktree.worktreePath || destination.kind !== 'local' ||
        destination.path !== worktree.repositoryRoot))) return undefined
  return {
    direction: value.direction,
    worktree,
    baseCommit: value.baseCommit,
    ...(value.sourceTree === undefined ? {} : { sourceTree: value.sourceTree }),
    source,
    destination,
    files: files as WorktreeHandoffFile[],
    patch: value.patch,
    blockers,
    canTransfer: value.canTransfer,
  }
}

export function parseWorktreeHandoffPreview(value: unknown): WorktreeHandoffPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'expiresAt', 'preflight']) ||
    !isUuid(value.previewId) || !isIsoDate(value.expiresAt)) return undefined
  const preflight = parseWorktreeHandoffPreflight(value.preflight)
  return preflight === undefined ? undefined : { previewId: value.previewId, expiresAt: value.expiresAt, preflight }
}

export function parseDesktopWorktreeHandoffConfirmInput(
  value: unknown,
): DesktopWorktreeHandoffConfirmInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'confirmed']) ||
    !isUuid(value.previewId) || value.confirmed !== true) return undefined
  return { previewId: value.previewId, confirmed: true }
}

export function parseWorktreeHandoffResult(value: unknown): WorktreeHandoffResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'direction', 'sourceTree']) ||
    !isUuid(value.operationId) || !isDirection(value.direction) || !isObjectId(value.sourceTree)) return undefined
  return { operationId: value.operationId, direction: value.direction, sourceTree: value.sourceTree }
}
