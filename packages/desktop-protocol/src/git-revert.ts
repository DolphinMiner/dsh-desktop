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

const MAX_PATH_LENGTH = 4_096

export interface DesktopGitRevertPreviewInput extends GitDiscoverParams {
  path: string
}

export interface GitRevertPreview {
  previewId: string
  path: string
  expiresAt: string
  review: GitReviewSnapshot
}

export interface DesktopGitRevertConfirmInput extends GitDiscoverParams {
  previewId: string
  confirmed: true
}

export interface GitRevertParams extends GitStatusParams {
  operationId: string
  path: string
}

export interface GitRevertResult {
  operationId: string
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

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0')
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

export function parseDesktopGitRevertPreviewInput(value: unknown): DesktopGitRevertPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'path']) || !isPath(value.path)) {
    return undefined
  }
  const base = parseGitDiscoverParams(value)
  return base === undefined ? undefined : { ...base, path: value.path }
}

export function parseGitRevertPreview(value: unknown): GitRevertPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'path', 'expiresAt', 'review']) ||
    !isUuid(value.previewId) || !isPath(value.path) || !isIsoDate(value.expiresAt)) return undefined
  const review = parseGitReviewSnapshot(value.review)
  return review === undefined || review.scope.kind !== 'unstaged' ||
    !review.files.some(file => file.path === value.path)
    ? undefined
    : { previewId: value.previewId, path: value.path, expiresAt: value.expiresAt, review }
}

export function parseDesktopGitRevertConfirmInput(value: unknown): DesktopGitRevertConfirmInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'previewId', 'confirmed']) ||
    !isUuid(value.previewId) || value.confirmed !== true) return undefined
  const base = parseGitDiscoverParams(value)
  return base === undefined ? undefined : { ...base, previewId: value.previewId, confirmed: true }
}

export function parseGitRevertParams(value: unknown): GitRevertParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'repositoryRoot', 'operationId', 'path',
  ]) || !isUuid(value.operationId) || !isPath(value.path)) return undefined
  const base = parseGitStatusParams(value)
  return base === undefined ? undefined : { ...base, operationId: value.operationId, path: value.path }
}

export function parseGitRevertResult(value: unknown): GitRevertResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'status']) || !isUuid(value.operationId)) {
    return undefined
  }
  const status = parseGitStatusSnapshot(value.status)
  return status === undefined ? undefined : { operationId: value.operationId, status }
}
