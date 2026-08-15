import type { GitDiscoverParams, GitReviewScope } from './git.js'
import { parseGitDiscoverParams, parseGitReviewScope } from './git.js'

const MAX_PATH_LENGTH = 4_096
const MAX_COMMENT_LENGTH = 4_000
const MAX_COMMENTS = 10_000
const MAX_LINE_NUMBER = 10_000_000

export type GitReviewCommentSide = 'old' | 'new'

export interface GitReviewCommentAnchor {
  path: string
  side: GitReviewCommentSide
  line: number
  blob: string
}

export interface GitReviewComment {
  id: string
  anchor: GitReviewCommentAnchor
  body: string
  createdAt: string
}

export interface GitReviewCommentSnapshot {
  revision: number
  repositoryCommonDir: string
  comments: GitReviewComment[]
}

export interface GitReviewCommentsChangedEvent {
  revision: number
  repositoryCommonDir: string
}

export type DesktopGitReviewCommentsInput = GitDiscoverParams

export interface AddGitReviewCommentInput extends GitDiscoverParams {
  requestId: string
  scope: GitReviewScope
  anchor: GitReviewCommentAnchor
  body: string
}

export interface DeleteGitReviewCommentInput extends GitDiscoverParams {
  commentId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isUuid(value: unknown): value is string {
  return isBoundedString(value, 36) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isBlob(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && !/^0+$/.test(value)
}

function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value))
}

export function parseGitReviewCommentAnchor(value: unknown): GitReviewCommentAnchor | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['path', 'side', 'line', 'blob']) ||
    !isBoundedString(value.path, MAX_PATH_LENGTH) || (value.side !== 'old' && value.side !== 'new') ||
    !Number.isSafeInteger(value.line) || Number(value.line) < 1 || Number(value.line) > MAX_LINE_NUMBER ||
    !isBlob(value.blob)) return undefined
  return { path: value.path, side: value.side, line: Number(value.line), blob: value.blob }
}

export function parseGitReviewComment(value: unknown): GitReviewComment | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'anchor', 'body', 'createdAt']) ||
    !isUuid(value.id) || !isBoundedString(value.body, MAX_COMMENT_LENGTH) ||
    value.body.trim() === '' || !isIsoDate(value.createdAt)) return undefined
  const anchor = parseGitReviewCommentAnchor(value.anchor)
  return anchor === undefined ? undefined : {
    id: value.id,
    anchor,
    body: value.body,
    createdAt: value.createdAt,
  }
}

export function parseDesktopGitReviewCommentsInput(value: unknown): DesktopGitReviewCommentsInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot'])) return undefined
  return parseGitDiscoverParams(value)
}

export function parseAddGitReviewCommentInput(value: unknown): AddGitReviewCommentInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'requestId', 'scope', 'anchor', 'body',
  ]) || !isUuid(value.requestId) || !isBoundedString(value.body, MAX_COMMENT_LENGTH) ||
    value.body.trim() === '') return undefined
  const base = parseGitDiscoverParams(value)
  const scope = parseGitReviewScope(value.scope)
  const anchor = parseGitReviewCommentAnchor(value.anchor)
  return base === undefined || scope === undefined || anchor === undefined
    ? undefined
    : { ...base, requestId: value.requestId, scope, anchor, body: value.body }
}

export function parseDeleteGitReviewCommentInput(value: unknown): DeleteGitReviewCommentInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'commentId']) ||
    !isUuid(value.commentId)) return undefined
  const base = parseGitDiscoverParams(value)
  return base === undefined ? undefined : { ...base, commentId: value.commentId }
}

export function parseGitReviewCommentSnapshot(value: unknown): GitReviewCommentSnapshot | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['revision', 'repositoryCommonDir', 'comments']) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !isBoundedString(value.repositoryCommonDir, MAX_PATH_LENGTH) ||
    !Array.isArray(value.comments) || value.comments.length > MAX_COMMENTS) return undefined
  const comments = value.comments.map(parseGitReviewComment)
  if (comments.some(comment => comment === undefined) ||
    new Set((comments as GitReviewComment[]).map(comment => comment.id)).size !== comments.length) return undefined
  return {
    revision: Number(value.revision),
    repositoryCommonDir: value.repositoryCommonDir,
    comments: comments as GitReviewComment[],
  }
}

export function parseGitReviewCommentsChangedEvent(value: unknown): GitReviewCommentsChangedEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['revision', 'repositoryCommonDir']) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !isBoundedString(value.repositoryCommonDir, MAX_PATH_LENGTH)) return undefined
  return { revision: Number(value.revision), repositoryCommonDir: value.repositoryCommonDir }
}
