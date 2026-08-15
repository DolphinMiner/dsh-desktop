import type {
  GitDiscoverParams,
  GitReviewSnapshot,
  GitStatusParams,
  GitStatusSnapshot,
} from './git.js'
import {
  parseGitDiscoverParams,
  parseGitReviewSnapshot,
  parseGitStatusParams,
  parseGitStatusSnapshot,
} from './git.js'

const MAX_COMMIT_MESSAGE_LENGTH = 8_192

export interface DesktopGitCommitPreviewInput extends GitDiscoverParams {}

export interface GitCommitPreview {
  previewId: string
  expiresAt: string
  review: GitReviewSnapshot
}

export interface DesktopGitCommitConfirmInput extends GitDiscoverParams {
  previewId: string
  message: string
  confirmed: true
}

export interface GitCommitParams extends GitStatusParams {
  operationId: string
  message: string
  expectedHead?: string
  expectedTree: string
}

export interface GitCommitResult {
  operationId: string
  commit: string
  status: GitStatusSnapshot
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

function isCommitMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_COMMIT_MESSAGE_LENGTH &&
    value.trim().length > 0 && !value.includes('\0')
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

export function parseDesktopGitCommitPreviewInput(value: unknown): DesktopGitCommitPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot'])) return undefined
  return parseGitDiscoverParams(value)
}

export function parseGitCommitPreview(value: unknown): GitCommitPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'expiresAt', 'review']) ||
    !isUuid(value.previewId) || !isIsoDate(value.expiresAt)) return undefined
  const review = parseGitReviewSnapshot(value.review)
  return review === undefined || review.scope.kind !== 'staged' || review.files.length === 0
    ? undefined
    : { previewId: value.previewId, expiresAt: value.expiresAt, review }
}

export function parseDesktopGitCommitConfirmInput(value: unknown): DesktopGitCommitConfirmInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'previewId', 'message', 'confirmed',
  ]) || !isUuid(value.previewId) || !isCommitMessage(value.message) || value.confirmed !== true) return undefined
  const base = parseGitDiscoverParams(value)
  return base === undefined
    ? undefined
    : { ...base, previewId: value.previewId, message: value.message, confirmed: true }
}

export function parseGitCommitParams(value: unknown): GitCommitParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'repositoryRoot', 'operationId', 'message', 'expectedHead', 'expectedTree',
  ]) || !isUuid(value.operationId) || !isCommitMessage(value.message) || !isObjectId(value.expectedTree) ||
    (value.expectedHead !== undefined && !isObjectId(value.expectedHead))) return undefined
  const base = parseGitStatusParams(value)
  return base === undefined ? undefined : {
    ...base,
    operationId: value.operationId,
    message: value.message,
    ...(value.expectedHead === undefined ? {} : { expectedHead: value.expectedHead as string }),
    expectedTree: value.expectedTree,
  }
}

export function parseGitCommitResult(value: unknown): GitCommitResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'commit', 'status']) ||
    !isUuid(value.operationId) || !isObjectId(value.commit)) return undefined
  const status = parseGitStatusSnapshot(value.status)
  return status === undefined || status.head !== value.commit
    ? undefined
    : { operationId: value.operationId, commit: value.commit, status }
}
