import { isAbsolute, normalize } from 'node:path'

import type {
  GitReviewComment,
  GitReviewCommentAnchor,
  GitReviewCommentSnapshot,
  GitReviewCommentsChangedEvent,
} from '@dolphinminer/dsh-desktop-protocol'
import { parseGitReviewComment, parseGitReviewCommentAnchor } from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const GIT_REVIEW_COMMENTS_SCHEMA_VERSION = 1 as const
const MAX_COMMENTS = 10_000
const MAX_PATH_LENGTH = 4_096

interface StoredGitReviewComment extends GitReviewComment {
  repositoryCommonDir: string
}

interface GitReviewCommentDocument {
  schemaVersion: typeof GIT_REVIEW_COMMENTS_SCHEMA_VERSION
  revision: number
  comments: StoredGitReviewComment[]
}

export interface AddGitReviewCommentRecord {
  id: string
  repositoryCommonDir: string
  anchor: GitReviewCommentAnchor
  body: string
}

export interface GitReviewCommentStoreOptions {
  now?: () => Date
  maxComments?: number
  write?: typeof writeJsonAtomically
  onChange?: (event: GitReviewCommentsChangedEvent) => void
}

export class GitReviewCommentStoreError extends Error {
  constructor(
    readonly code: 'BAD_MESSAGE' | 'DESKTOP_UNAVAILABLE' | 'DUPLICATE_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'GitReviewCommentStoreError'
  }
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

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') && isAbsolute(value) && normalize(value) === value
}

function parseStoredComment(value: unknown): StoredGitReviewComment | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'repositoryCommonDir', 'anchor', 'body', 'createdAt']) ||
    !isCanonicalAbsolutePath(value.repositoryCommonDir)) return undefined
  const comment = parseGitReviewComment({
    id: value.id,
    anchor: value.anchor,
    body: value.body,
    createdAt: value.createdAt,
  })
  return comment === undefined ? undefined : { ...comment, repositoryCommonDir: value.repositoryCommonDir }
}

function emptyDocument(): GitReviewCommentDocument {
  return { schemaVersion: GIT_REVIEW_COMMENTS_SCHEMA_VERSION, revision: 0, comments: [] }
}

function parseDocument(value: unknown): GitReviewCommentDocument {
  if (value === undefined) return emptyDocument()
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'comments']) ||
    value.schemaVersion !== GIT_REVIEW_COMMENTS_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.comments) || value.comments.length > MAX_COMMENTS) {
    throw new Error('The Git review comment store uses an unsupported or invalid document shape.')
  }
  const comments = value.comments.map(parseStoredComment)
  if (comments.some(comment => comment === undefined)) {
    throw new Error('The Git review comment store contains an invalid comment.')
  }
  const parsed = comments as StoredGitReviewComment[]
  if (new Set(parsed.map(comment => comment.id)).size !== parsed.length) {
    throw new Error('The Git review comment store contains duplicate identifiers.')
  }
  return {
    schemaVersion: GIT_REVIEW_COMMENTS_SCHEMA_VERSION,
    revision: Number(value.revision),
    comments: parsed,
  }
}

function cloneComment(comment: GitReviewComment): GitReviewComment {
  return { ...comment, anchor: { ...comment.anchor } }
}

function cloneStoredComment(comment: StoredGitReviewComment): StoredGitReviewComment {
  return { ...cloneComment(comment), repositoryCommonDir: comment.repositoryCommonDir }
}

function matchesCreation(comment: StoredGitReviewComment, input: AddGitReviewCommentRecord): boolean {
  return comment.repositoryCommonDir === input.repositoryCommonDir && comment.body === input.body &&
    comment.anchor.path === input.anchor.path && comment.anchor.side === input.anchor.side &&
    comment.anchor.line === input.anchor.line && comment.anchor.blob === input.anchor.blob
}

export class GitReviewCommentStore {
  private state = emptyDocument()
  private available = true
  private unavailableReason?: string
  private readonly now: () => Date
  private readonly maxComments: number
  private readonly write: typeof writeJsonAtomically
  private readonly onChange?: (event: GitReviewCommentsChangedEvent) => void

  constructor(
    private readonly path: string,
    options: GitReviewCommentStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.maxComments = Math.max(1, Math.min(options.maxComments ?? MAX_COMMENTS, MAX_COMMENTS))
    this.write = options.write ?? writeJsonAtomically
    this.onChange = options.onChange
    try {
      this.state = parseDocument(readJsonFile(path))
    } catch {
      this.available = false
      this.unavailableReason = 'Git review comments could not be loaded safely.'
    }
  }

  status(): { available: boolean; revision: number; message?: string } {
    return {
      available: this.available,
      revision: this.state.revision,
      ...(this.unavailableReason === undefined ? {} : { message: this.unavailableReason }),
    }
  }

  snapshot(repositoryCommonDir: string): GitReviewCommentSnapshot {
    this.assertAvailable()
    if (!isCanonicalAbsolutePath(repositoryCommonDir)) {
      throw new GitReviewCommentStoreError('BAD_MESSAGE', 'The Git repository identity is invalid.')
    }
    return {
      revision: this.state.revision,
      repositoryCommonDir,
      comments: this.state.comments
        .filter(comment => comment.repositoryCommonDir === repositoryCommonDir)
        .map(cloneComment),
    }
  }

  add(input: AddGitReviewCommentRecord): GitReviewCommentSnapshot {
    this.assertAvailable()
    const anchor = parseGitReviewCommentAnchor(input.anchor)
    if (!isUuid(input.id) || !isCanonicalAbsolutePath(input.repositoryCommonDir) || anchor === undefined ||
      typeof input.body !== 'string' || input.body.length < 1 || input.body.length > 4_000 ||
      input.body.includes('\0') || input.body.trim() === '') {
      throw new GitReviewCommentStoreError('BAD_MESSAGE', 'The Git review comment is invalid.')
    }
    const normalized = { ...input, anchor }
    const existing = this.state.comments.find(comment => comment.id === input.id)
    if (existing !== undefined) {
      if (!matchesCreation(existing, normalized)) {
        throw new GitReviewCommentStoreError(
          'DUPLICATE_REQUEST',
          'The Git review comment identifier was already used for a different comment.',
        )
      }
      return this.snapshot(input.repositoryCommonDir)
    }
    if (this.state.comments.length >= this.maxComments) {
      throw new GitReviewCommentStoreError('DESKTOP_UNAVAILABLE', 'The Git review comment store is full.')
    }
    const comment: StoredGitReviewComment = {
      id: input.id,
      repositoryCommonDir: input.repositoryCommonDir,
      anchor,
      body: input.body,
      createdAt: this.now().toISOString(),
    }
    this.commit(input.repositoryCommonDir, next => next.comments.push(comment))
    return this.snapshot(input.repositoryCommonDir)
  }

  remove(repositoryCommonDir: string, commentId: string): GitReviewCommentSnapshot {
    this.assertAvailable()
    if (!isCanonicalAbsolutePath(repositoryCommonDir) || !isUuid(commentId)) {
      throw new GitReviewCommentStoreError('BAD_MESSAGE', 'The Git review comment removal is invalid.')
    }
    const index = this.state.comments.findIndex(comment =>
      comment.repositoryCommonDir === repositoryCommonDir && comment.id === commentId)
    if (index < 0) {
      throw new GitReviewCommentStoreError('NOT_FOUND', 'The Git review comment was not found.')
    }
    this.commit(repositoryCommonDir, next => {
      const nextIndex = next.comments.findIndex(comment =>
        comment.repositoryCommonDir === repositoryCommonDir && comment.id === commentId)
      if (nextIndex < 0) throw new GitReviewCommentStoreError('NOT_FOUND', 'The Git review comment was not found.')
      next.comments.splice(nextIndex, 1)
    })
    return this.snapshot(repositoryCommonDir)
  }

  private commit(repositoryCommonDir: string, change: (next: GitReviewCommentDocument) => void): void {
    this.assertAvailable()
    const next: GitReviewCommentDocument = {
      schemaVersion: GIT_REVIEW_COMMENTS_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      comments: this.state.comments.map(cloneStoredComment),
    }
    change(next)
    try {
      this.write(this.path, next)
      this.state = next
    } catch (error) {
      if (error instanceof GitReviewCommentStoreError) throw error
      this.available = false
      this.unavailableReason = 'Git review comments could not be persisted safely.'
      throw new GitReviewCommentStoreError('DESKTOP_UNAVAILABLE', this.unavailableReason)
    }
    try {
      this.onChange?.({ revision: next.revision, repositoryCommonDir })
    } catch {
      // Notification delivery is a projection; the durable store remains authoritative.
    }
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new GitReviewCommentStoreError(
        'DESKTOP_UNAVAILABLE',
        this.unavailableReason ?? 'Git review comments are unavailable.',
      )
    }
  }
}
