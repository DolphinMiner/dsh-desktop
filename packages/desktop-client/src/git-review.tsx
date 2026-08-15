import type { CSSProperties, FormEvent } from 'react'
import { Fragment, useEffect, useMemo, useState } from 'react'

import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconBranchOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSendOutline16,
  IconTrashOutline16,
  Input,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AddGitReviewCommentInput,
  DesktopGitReviewInput,
  DesktopGitReviewCommentsInput,
  DesktopGitIndexMutationInput,
  DeleteGitReviewCommentInput,
  GitReviewFile,
  GitReviewComment,
  GitReviewCommentAnchor,
  GitReviewCommentSnapshot,
  GitReviewCommentsChangedEvent,
  GitReviewScope,
  GitReviewSnapshot,
  GitIndexMutationResult,
  ReviewDiffLine,
  ReviewPatchFile,
} from '@dolphinminer/dsh-desktop-protocol'
import { parseGitReviewPatch } from '@dolphinminer/dsh-desktop-protocol'

import {
  anchorForDiffLine,
  projectGitReviewComments,
  sameGitReviewAnchor,
  type ProjectedGitReviewComment,
} from './git-review-comment-model.js'

export interface DesktopGitBridge {
  review(input: DesktopGitReviewInput): Promise<GitReviewSnapshot>
  mutateIndex(input: DesktopGitIndexMutationInput): Promise<GitIndexMutationResult>
  comments: {
    list(input: DesktopGitReviewCommentsInput): Promise<GitReviewCommentSnapshot>
    add(input: AddGitReviewCommentInput): Promise<GitReviewCommentSnapshot>
    remove(input: DeleteGitReviewCommentInput): Promise<GitReviewCommentSnapshot>
    onChanged(listener: (event: GitReviewCommentsChangedEvent) => void): () => void
  }
}

interface GitReviewViewProps extends ConvViewProps {
  bridge?: DesktopGitBridge
}

type ReviewScopeKind = GitReviewScope['kind']

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    height: '100%',
    minHeight: 0,
  },
  toolbar: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    minHeight: 52,
    padding: '8px 16px',
  },
  scopeSelect: {
    appearance: 'auto',
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    color: 'inherit',
    font: 'inherit',
    height: 34,
    padding: '0 9px',
  },
  refInput: { maxWidth: 240, minWidth: 140 },
  repository: {
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 12,
    marginLeft: 'auto',
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  content: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)',
    minHeight: 0,
  },
  files: {
    borderRight: '1px solid var(--dsw-alias-border-l2, #deded9)',
    minHeight: 0,
    overflow: 'auto',
    padding: '8px 0',
  },
  fileButton: {
    alignItems: 'center',
    background: 'transparent',
    border: 0,
    color: 'inherit',
    cursor: 'pointer',
    display: 'grid',
    font: 'inherit',
    gap: 8,
    gridTemplateColumns: '24px minmax(0, 1fr)',
    minHeight: 36,
    padding: '6px 12px',
    textAlign: 'left',
    width: '100%',
  },
  fileStatus: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
  filePath: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  patch: { minHeight: 0, overflow: 'auto' },
  patchHeader: {
    alignItems: 'center',
    background: 'var(--dsw-alias-bg-base, #fff)',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    gap: 8,
    minHeight: 42,
    padding: '0 14px',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  patchPath: {
    flex: 1,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hunkHeader: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    lineHeight: '28px',
    padding: '0 12px',
  },
  diffLine: {
    display: 'grid',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    gridTemplateColumns: '28px 48px 48px 18px minmax(max-content, 1fr)',
    lineHeight: '20px',
    minHeight: 20,
  },
  lineAction: {
    alignItems: 'center',
    display: 'flex',
    height: 20,
    justifyContent: 'center',
  },
  lineActionButton: {
    height: 20,
    minHeight: 20,
    minWidth: 20,
    padding: 0,
    width: 20,
  },
  iconButton: {
    alignItems: 'center',
    background: 'transparent',
    border: 0,
    borderRadius: 4,
    color: 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    height: 28,
    justifyContent: 'center',
    padding: 0,
    width: 28,
  },
  primaryIconButton: {
    background: 'var(--dsw-alias-button-primary-bg, #1f6feb)',
    color: 'var(--dsw-alias-button-primary-label, #fff)',
  },
  lineNumber: {
    borderRight: '1px solid var(--dsw-alias-border-l2, #deded9)',
    color: 'var(--dsw-alias-label-tertiary, #8a8d91)',
    padding: '0 7px',
    textAlign: 'right',
    userSelect: 'none',
  },
  marker: { textAlign: 'center', userSelect: 'none' },
  lineText: { paddingRight: 16, tabSize: 4, whiteSpace: 'pre' },
  commentSurface: {
    display: 'grid',
    gridTemplateColumns: '122px minmax(0, 720px)',
    padding: '6px 16px 6px 0',
  },
  comment: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    borderLeft: '2px solid var(--dsw-alias-border-emphasis, #6f7378)',
    gridColumn: 2,
    minWidth: 0,
    padding: '8px 10px',
  },
  commentMeta: {
    alignItems: 'center',
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    display: 'flex',
    fontSize: 11,
    gap: 8,
    justifyContent: 'space-between',
    minHeight: 20,
  },
  commentBody: {
    fontSize: 13,
    lineHeight: '19px',
    overflowWrap: 'anywhere',
    paddingTop: 4,
    whiteSpace: 'pre-wrap',
  },
  commentComposer: {
    borderLeft: '2px solid var(--dsw-alias-accent-primary, #3a6ea5)',
    display: 'grid',
    gap: 8,
    gridColumn: 2,
    padding: '8px 10px',
  },
  commentInput: {
    background: 'var(--dsw-alias-bg-base, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    boxSizing: 'border-box',
    color: 'inherit',
    font: 'inherit',
    lineHeight: '19px',
    minHeight: 72,
    padding: '7px 9px',
    resize: 'vertical',
    width: '100%',
  },
  commentActions: { display: 'flex', gap: 6, justifyContent: 'flex-end' },
  unresolved: {
    borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'grid',
    gap: 8,
    padding: 14,
  },
  unresolvedHeading: { fontSize: 12, fontWeight: 600 },
  unresolvedComment: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    borderLeft: '2px solid var(--dsw-alias-state-warning-primary, #a66b00)',
    minWidth: 0,
    padding: '8px 10px',
  },
  unresolvedIdentity: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  state: {
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 13,
    lineHeight: '20px',
    padding: 24,
  },
}

const statusLabels: Record<GitReviewFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  unmerged: 'U',
  untracked: '?',
}

function lineStyle(line: ReviewDiffLine): CSSProperties {
  if (line.kind === 'addition') return { background: 'var(--dsw-alias-state-success-secondary, #ecf8ef)' }
  if (line.kind === 'deletion') return { background: 'var(--dsw-alias-state-error-secondary, #fef0ef)' }
  return {}
}

function lineMarker(line: ReviewDiffLine): string {
  if (line.kind === 'addition') return '+'
  if (line.kind === 'deletion') return '-'
  return line.kind === 'metadata' ? '\\' : ' '
}

function reviewErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return 'Git review failed.'
  const marker = 'Error invoking remote method'
  const markerIndex = cause.message.indexOf(marker)
  if (markerIndex < 0) return cause.message
  const separatorIndex = cause.message.indexOf(':', markerIndex)
  return separatorIndex < 0 ? 'Git review failed.' : cause.message.slice(separatorIndex + 1).trim()
}

function anchorKey(anchor: GitReviewCommentAnchor): string {
  return JSON.stringify([anchor.path, anchor.side, anchor.line, anchor.blob])
}

function commentLocation(comment: GitReviewComment): string {
  return `${comment.anchor.path}:${String(comment.anchor.line)} (${comment.anchor.side})`
}

function CommentDeleteButton({
  commentId,
  pending,
  onRemove,
}: {
  commentId: string
  pending: boolean
  onRemove: (commentId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      style={styles.iconButton}
      aria-label="Delete comment"
      title="Delete comment"
      disabled={pending}
      onClick={() => onRemove(commentId)}
    >
      <IconTrashOutline16 />
    </button>
  )
}

function InlineComment({
  comment,
  pending,
  onRemove,
}: {
  comment: GitReviewComment
  pending: boolean
  onRemove: (commentId: string) => void
}): React.JSX.Element {
  return (
    <div style={styles.commentSurface}>
      <div style={styles.comment}>
        <div style={styles.commentMeta}>
          <span>{new Date(comment.createdAt).toLocaleString()}</span>
          <CommentDeleteButton commentId={comment.id} pending={pending} onRemove={onRemove} />
        </div>
        <div style={styles.commentBody}>{comment.body}</div>
      </div>
    </div>
  )
}

function UnresolvedComments({
  comments,
  pendingComment,
  onRemove,
}: {
  comments: ProjectedGitReviewComment[]
  pendingComment?: string
  onRemove: (commentId: string) => void
}): React.JSX.Element | null {
  if (comments.length === 0) return null
  return (
    <section style={styles.unresolved} aria-label="Unresolved review comments">
      <div style={styles.unresolvedHeading}>Unresolved comments</div>
      {comments.map(({ comment, state }) => (
        <div key={comment.id} style={styles.unresolvedComment}>
          <div style={styles.commentMeta}>
            <span style={styles.unresolvedIdentity} title={commentLocation(comment)}>
              {commentLocation(comment)}
            </span>
            <Pill>{state === 'stale' ? 'Stale anchor' : 'Outside scope'}</Pill>
            <CommentDeleteButton
              commentId={comment.id}
              pending={pendingComment === comment.id}
              onRemove={onRemove}
            />
          </div>
          <div style={styles.commentBody}>{comment.body}</div>
        </div>
      ))}
    </section>
  )
}

function scopeFrom(kind: ReviewScopeKind, commitRef: string, baseRef: string): GitReviewScope | undefined {
  if (kind === 'unstaged' || kind === 'staged') return { kind }
  const ref = (kind === 'commit' ? commitRef : baseRef).trim()
  if (ref === '') return undefined
  return kind === 'commit' ? { kind, ref } : { kind, baseRef: ref }
}

export function GitReviewView({ bridge, sessionId, useSessions }: GitReviewViewProps): React.JSX.Element {
  const workspaceRoot = useSessions(state => state.byId[sessionId]?.cwd)
  const [scopeKind, setScopeKind] = useState<ReviewScopeKind>('unstaged')
  const [commitRef, setCommitRef] = useState('HEAD')
  const [baseRef, setBaseRef] = useState('main')
  const [requestedScope, setRequestedScope] = useState<GitReviewScope>({ kind: 'unstaged' })
  const [snapshot, setSnapshot] = useState<GitReviewSnapshot>()
  const [selectedPath, setSelectedPath] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [comments, setComments] = useState<GitReviewCommentSnapshot>()
  const [commentError, setCommentError] = useState<string>()
  const [commentDraft, setCommentDraft] = useState<{
    requestId: string
    anchor: GitReviewCommentAnchor
  }>()
  const [commentBody, setCommentBody] = useState('')
  const [pendingComment, setPendingComment] = useState<string>()
  const [pendingMutation, setPendingMutation] = useState<'stage' | 'unstage'>()
  const [mutationError, setMutationError] = useState<string>()

  useEffect(() => {
    let current = true
    if (bridge === undefined || workspaceRoot === undefined) {
      setLoading(false)
      setError(bridge === undefined
        ? 'The desktop Git bridge is unavailable.'
        : 'This session has no workspace.')
      return () => { current = false }
    }
    setLoading(true)
    setError(undefined)
    void bridge.review({ sessionId, workspaceRoot, scope: requestedScope }).then(next => {
      if (!current) return
      setSnapshot(next)
      setCommentDraft(undefined)
      setCommentBody('')
      setSelectedPath(previous => next.files.some(file => file.path === previous)
        ? previous
        : next.files[0]?.path)
    }).catch(cause => {
      if (!current) return
      setError(reviewErrorMessage(cause))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [bridge, requestedScope, sessionId, workspaceRoot])

  useEffect(() => {
    let current = true
    setComments(undefined)
    if (bridge === undefined || workspaceRoot === undefined) return () => { current = false }
    setCommentError(undefined)
    void bridge.comments.list({ sessionId, workspaceRoot }).then(next => {
      if (!current) return
      setComments(next)
    }).catch(cause => {
      if (!current) return
      setCommentError(reviewErrorMessage(cause))
    })
    return () => { current = false }
  }, [bridge, sessionId, workspaceRoot])

  useEffect(() => {
    if (bridge === undefined || workspaceRoot === undefined || snapshot === undefined) return
    let current = true
    const stop = bridge.comments.onChanged(change => {
      if (change.repositoryCommonDir !== snapshot.repository.commonDir) return
      void bridge.comments.list({ sessionId, workspaceRoot }).then(next => {
        if (!current) return
        setComments(previous => previous !== undefined && previous.revision > next.revision ? previous : next)
        setCommentError(undefined)
      }).catch(cause => {
        if (current) setCommentError(reviewErrorMessage(cause))
      })
    })
    return () => {
      current = false
      stop()
    }
  }, [bridge, sessionId, snapshot, workspaceRoot])

  const parsed = useMemo(() => {
    if (snapshot === undefined) return { files: [] as ReviewPatchFile[] }
    try {
      return { files: parseGitReviewPatch(snapshot.patch) }
    } catch (cause) {
      return {
        files: [] as ReviewPatchFile[],
        error: cause instanceof Error ? cause.message : 'Invalid Git patch.',
      }
    }
  }, [snapshot])
  const selected = snapshot?.files.find(file => file.path === selectedPath)
  const selectedPatch = parsed.files.find(file => file.path === selectedPath)
  const projectedComments = useMemo(() => {
    const repositoryComments = comments !== undefined &&
      comments.repositoryCommonDir === snapshot?.repository.commonDir
      ? comments.comments
      : []
    return projectGitReviewComments(parsed.files, repositoryComments)
  }, [comments, parsed.files, snapshot?.repository.commonDir])
  const activeComments = useMemo(() => {
    const byAnchor = new Map<string, GitReviewComment[]>()
    for (const projected of projectedComments) {
      if (projected.state !== 'active') continue
      const key = anchorKey(projected.comment.anchor)
      byAnchor.set(key, [...(byAnchor.get(key) ?? []), projected.comment])
    }
    return byAnchor
  }, [projectedComments])
  const unresolvedComments = projectedComments.filter(projected => projected.state !== 'active')

  const requestReview = (): void => {
    const scope = scopeFrom(scopeKind, commitRef, baseRef)
    if (scope === undefined) {
      setError('Enter a Git ref for this review scope.')
      return
    }
    setCommentDraft(undefined)
    setCommentBody('')
    setMutationError(undefined)
    setRequestedScope({ ...scope })
  }

  const mutateSelected = (): void => {
    if (bridge === undefined || workspaceRoot === undefined || snapshot === undefined || selected === undefined ||
      (snapshot.scope.kind !== 'unstaged' && snapshot.scope.kind !== 'staged')) return
    const kind = snapshot.scope.kind === 'unstaged' ? 'stage' : 'unstage'
    setPendingMutation(kind)
    setMutationError(undefined)
    void bridge.mutateIndex({
      sessionId,
      workspaceRoot,
      requestId: crypto.randomUUID(),
      kind,
      paths: [selected.path],
    }).then(() => {
      setMutationError(undefined)
      setRequestedScope({ ...snapshot.scope })
    }).catch(cause => {
      setMutationError(reviewErrorMessage(cause))
      setRequestedScope({ ...snapshot.scope })
    }).finally(() => setPendingMutation(undefined))
  }

  const beginComment = (anchor: GitReviewCommentAnchor): void => {
    setCommentDraft({ requestId: crypto.randomUUID(), anchor })
    setCommentBody('')
    setCommentError(undefined)
  }

  const submitComment = (event: FormEvent): void => {
    event.preventDefault()
    const body = commentBody.trim()
    if (bridge === undefined || workspaceRoot === undefined || snapshot === undefined ||
      commentDraft === undefined || body === '') return
    setPendingComment('add')
    setCommentError(undefined)
    void bridge.comments.add({
      sessionId,
      workspaceRoot,
      requestId: commentDraft.requestId,
      scope: snapshot.scope,
      anchor: commentDraft.anchor,
      body,
    }).then(next => {
      setComments(previous => previous !== undefined && previous.revision > next.revision ? previous : next)
      setCommentError(undefined)
      setCommentDraft(undefined)
      setCommentBody('')
    }).catch(cause => {
      setCommentError(reviewErrorMessage(cause))
    }).finally(() => setPendingComment(undefined))
  }

  const removeComment = (commentId: string): void => {
    if (bridge === undefined || workspaceRoot === undefined) return
    setPendingComment(commentId)
    setCommentError(undefined)
    void bridge.comments.remove({ sessionId, workspaceRoot, commentId }).then(next => {
      setComments(previous => previous !== undefined && previous.revision > next.revision ? previous : next)
      setCommentError(undefined)
    }).catch(cause => {
      setCommentError(reviewErrorMessage(cause))
    }).finally(() => setPendingComment(undefined))
  }

  return (
    <section style={styles.root} aria-label="Git review">
      <div style={styles.toolbar}>
        <select
          style={styles.scopeSelect}
          aria-label="Review scope"
          value={scopeKind}
          onChange={event => setScopeKind(event.currentTarget.value as ReviewScopeKind)}
        >
          <option value="unstaged">Unstaged</option>
          <option value="staged">Staged</option>
          <option value="commit">Commit</option>
          <option value="branch">Branch</option>
        </select>
        {scopeKind === 'commit' && (
          <Input
            aria-label="Commit ref"
            style={styles.refInput}
            value={commitRef}
            maxLength={1024}
            spellCheck={false}
            onChange={event => setCommitRef(event.currentTarget.value)}
          />
        )}
        {scopeKind === 'branch' && (
          <Input
            aria-label="Base ref"
            style={styles.refInput}
            value={baseRef}
            maxLength={1024}
            spellCheck={false}
            onChange={event => setBaseRef(event.currentTarget.value)}
          />
        )}
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRefreshOutline16 />}
          disabled={loading}
          onClick={requestReview}
        >
          Refresh
        </Button>
        <span style={styles.repository} title={snapshot?.repository.root ?? workspaceRoot}>
          {snapshot?.repository.root ?? workspaceRoot}
        </span>
      </div>

      {error !== undefined && <div role="alert" style={styles.state}>{error}</div>}
      {error === undefined && loading && <div style={styles.state}>Loading changes...</div>}
      {error === undefined && !loading && snapshot?.files.length === 0 && (
        <div style={{ minHeight: 0, overflow: 'auto' }}>
          <div style={styles.state}>No changes in this scope.</div>
          {commentError !== undefined && <div role="alert" style={styles.state}>{commentError}</div>}
          <UnresolvedComments
            comments={unresolvedComments}
            pendingComment={pendingComment}
            onRemove={removeComment}
          />
        </div>
      )}
      {error === undefined && !loading && snapshot !== undefined && snapshot.files.length > 0 && (
        <div style={styles.content}>
          <nav style={styles.files} aria-label="Changed files">
            {snapshot.files.map(file => (
              <button
                key={file.path}
                type="button"
                style={{
                  ...styles.fileButton,
                  ...(file.path === selectedPath
                    ? { background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)' }
                    : {}),
                }}
                title={file.path}
                aria-current={file.path === selectedPath ? 'true' : undefined}
                onClick={() => {
                  setSelectedPath(file.path)
                  setCommentDraft(undefined)
                  setCommentBody('')
                }}
              >
                <span style={styles.fileStatus}>{statusLabels[file.status]}</span>
                <span style={styles.filePath}>{file.path}</span>
              </button>
            ))}
          </nav>
          <div style={styles.patch}>
            {selected !== undefined && (
              <div style={styles.patchHeader}>
                <span style={styles.patchPath}>{selected.path}</span>
                <Pill>{selected.status}</Pill>
                {(snapshot.scope.kind === 'unstaged' || snapshot.scope.kind === 'staged') && (
                  <Button
                    size="sm"
                    variant="toolbar"
                    icon={<IconBranchOutline16 />}
                    disabled={loading || pendingMutation !== undefined}
                    title={snapshot.scope.kind === 'unstaged' ? 'Stage selected file' : 'Unstage selected file'}
                    onClick={mutateSelected}
                  >
                    {snapshot.scope.kind === 'unstaged' ? 'Stage' : 'Unstage'}
                  </Button>
                )}
              </div>
            )}
            {mutationError !== undefined && <div role="alert" style={styles.state}>{mutationError}</div>}
            {commentError !== undefined && <div role="alert" style={styles.state}>{commentError}</div>}
            {parsed.error !== undefined && <div role="alert" style={styles.state}>{parsed.error}</div>}
            {parsed.error === undefined && selected?.patchAvailable === false && (
              <div style={styles.state}>Untracked file content is not included in this review.</div>
            )}
            {parsed.error === undefined && selected?.patchAvailable !== false && selectedPatch?.binary === true && (
              <div style={styles.state}>Binary change</div>
            )}
            {parsed.error === undefined && selected?.patchAvailable !== false &&
              selectedPatch !== undefined && !selectedPatch.binary && selectedPatch.hunks.length === 0 && (
              <div style={styles.state}>No textual changes.</div>
            )}
            {parsed.error === undefined && selectedPatch?.hunks.map((hunk, hunkIndex) => (
              <div key={`${hunk.header}:${String(hunkIndex)}`}>
                <div style={styles.hunkHeader}>{hunk.header}</div>
                {hunk.lines.map((line, lineIndex) => {
                  const anchor = anchorForDiffLine(selectedPatch, line)
                  const lineComments = anchor === undefined ? [] : activeComments.get(anchorKey(anchor)) ?? []
                  const composing = anchor !== undefined && commentDraft !== undefined &&
                    sameGitReviewAnchor(anchor, commentDraft.anchor)
                  return (
                    <Fragment key={`${String(line.oldLine ?? '')}:${String(line.newLine ?? '')}:${String(lineIndex)}`}>
                      <div style={{ ...styles.diffLine, ...lineStyle(line) }}>
                        <span style={styles.lineAction}>
                          {anchor !== undefined && (
                            <button
                              type="button"
                              style={{ ...styles.iconButton, ...styles.lineActionButton }}
                              aria-label={`Add comment on ${anchor.side} line ${String(anchor.line)}`}
                              title="Add review comment"
                              disabled={pendingComment === 'add'}
                              onClick={() => beginComment(anchor)}
                            >
                              <IconPlusOutline16 />
                            </button>
                          )}
                        </span>
                        <span style={styles.lineNumber}>{line.oldLine ?? ''}</span>
                        <span style={styles.lineNumber}>{line.newLine ?? ''}</span>
                        <span style={styles.marker}>{lineMarker(line)}</span>
                        <span style={styles.lineText}>{line.text}</span>
                      </div>
                      {lineComments.map(comment => (
                        <InlineComment
                          key={comment.id}
                          comment={comment}
                          pending={pendingComment === comment.id}
                          onRemove={removeComment}
                        />
                      ))}
                      {composing && (
                        <div style={styles.commentSurface}>
                          <form style={styles.commentComposer} onSubmit={submitComment}>
                            <textarea
                              autoFocus
                              aria-label="Review comment"
                              style={styles.commentInput}
                              value={commentBody}
                              maxLength={4_000}
                              onChange={event => setCommentBody(event.currentTarget.value)}
                            />
                            <div style={styles.commentActions}>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={pendingComment === 'add'}
                                onClick={() => {
                                  setCommentDraft(undefined)
                                  setCommentBody('')
                                }}
                              >
                                Cancel
                              </Button>
                              <button
                                type="submit"
                                style={{ ...styles.iconButton, ...styles.primaryIconButton }}
                                aria-label="Save comment"
                                title="Save comment"
                                disabled={pendingComment === 'add' || commentBody.trim() === ''}
                              >
                                <IconSendOutline16 />
                              </button>
                            </div>
                          </form>
                        </div>
                      )}
                    </Fragment>
                  )
                })}
              </div>
            ))}
            {parsed.error === undefined && (
              <UnresolvedComments
                comments={unresolvedComments}
                pendingComment={pendingComment}
                onRemove={removeComment}
              />
            )}
          </div>
        </div>
      )}
    </section>
  )
}
