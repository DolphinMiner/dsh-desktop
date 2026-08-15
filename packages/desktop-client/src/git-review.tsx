import type { CSSProperties, FormEvent, ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconBranchOutline16,
  IconCheckOutline16,
  IconCloseOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSendOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AddGitReviewCommentInput,
  DesktopGitCommitConfirmInput,
  DesktopGitCommitPreviewInput,
  DesktopGitReviewInput,
  DesktopGitReviewCommentsInput,
  DesktopGitIndexMutationInput,
  DesktopGitRevertConfirmInput,
  DesktopGitRevertPreviewInput,
  DeleteGitReviewCommentInput,
  GitReviewFile,
  GitReviewComment,
  GitReviewCommentAnchor,
  GitReviewCommentSnapshot,
  GitReviewCommentsChangedEvent,
  GitReviewScope,
  GitReviewSnapshot,
  GitCommitPreview,
  GitCommitResult,
  GitIndexMutationResult,
  GitRevertPreview,
  GitRevertResult,
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
  previewCommit(input: DesktopGitCommitPreviewInput): Promise<GitCommitPreview>
  confirmCommit(input: DesktopGitCommitConfirmInput): Promise<GitCommitResult>
  previewRevert(input: DesktopGitRevertPreviewInput): Promise<GitRevertPreview>
  confirmRevert(input: DesktopGitRevertConfirmInput): Promise<GitRevertResult>
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
  confirmationOverlay: {
    alignItems: 'center',
    background: 'rgba(24, 26, 29, 0.42)',
    display: 'flex',
    inset: 0,
    justifyContent: 'center',
    padding: 24,
    position: 'fixed',
    zIndex: 1000,
  },
  confirmationDialog: {
    background: 'var(--dsw-alias-bg-base, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 8,
    boxShadow: '0 18px 48px rgba(24, 26, 29, 0.24)',
    color: 'var(--dsw-alias-label-primary, #25272a)',
    maxHeight: 'min(560px, calc(100vh - 48px))',
    maxWidth: 520,
    overflow: 'auto',
    width: '100%',
  },
  confirmationHeader: {
    alignItems: 'flex-start',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    gap: 12,
    padding: '16px 16px 14px 18px',
  },
  confirmationTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: 600,
    lineHeight: '22px',
    margin: 0,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  confirmationBody: { display: 'grid', gap: 14, padding: 18 },
  confirmationWarning: {
    alignItems: 'flex-start',
    background: 'var(--dsw-alias-state-warning-secondary, #fff8e6)',
    borderRadius: 6,
    display: 'flex',
    fontSize: 13,
    gap: 10,
    lineHeight: '19px',
    padding: 12,
  },
  confirmationSummary: {
    alignItems: 'flex-start',
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    borderRadius: 6,
    display: 'flex',
    fontSize: 13,
    gap: 10,
    lineHeight: '19px',
    padding: 12,
  },
  confirmationAcknowledge: {
    alignItems: 'flex-start',
    cursor: 'pointer',
    display: 'flex',
    fontSize: 13,
    gap: 9,
    lineHeight: '19px',
  },
  confirmationFooter: {
    borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    padding: '12px 16px',
  },
  commitMessageInput: {
    background: 'var(--dsw-alias-bg-base, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    boxSizing: 'border-box',
    color: 'inherit',
    font: 'inherit',
    lineHeight: '20px',
    minHeight: 96,
    padding: '8px 10px',
    resize: 'vertical',
    width: '100%',
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
  notice: {
    color: 'var(--dsw-alias-state-success-primary, #287a3d)',
    fontSize: 13,
    lineHeight: '20px',
    padding: '12px 24px',
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

function canRevert(file: GitReviewFile): boolean {
  return file.patchAvailable &&
    (file.status === 'modified' || file.status === 'deleted' || file.status === 'type-changed')
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

function ReviewConfirmationDialog({
  title,
  descriptionId,
  closeLabel,
  disabled,
  onCancel,
  children,
  actions,
}: {
  title: string
  descriptionId: string
  closeLabel: string
  disabled: boolean
  onCancel: () => void
  children: ReactNode
  actions: ReactNode
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    return () => {
      if (previousFocus?.isConnected === true) previousFocus.focus()
    }
  }, [])
  return createPortal(
    <div
      style={styles.confirmationOverlay}
      role="presentation"
      onMouseDown={event => {
        if (event.currentTarget === event.target && !disabled) onCancel()
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (!disabled) onCancel()
          return
        }
        if (event.key !== 'Tab') return
        const dialog = dialogRef.current
        const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
        ) ?? [])
        if (dialog === null || focusable.length === 0) {
          event.preventDefault()
          return
        }
        const first = focusable[0]!
        const last = focusable.at(-1)!
        const current = document.activeElement
        if (event.shiftKey && (current === first || !dialog.contains(current))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={descriptionId}
        style={styles.confirmationDialog}
      >
        <div style={styles.confirmationHeader}>
          <h2 style={styles.confirmationTitle}>{title}</h2>
          <button
            type="button"
            style={styles.iconButton}
            aria-label={closeLabel}
            title="Close"
            disabled={disabled}
            onClick={onCancel}
          >
            <IconCloseOutline16 />
          </button>
        </div>
        <div style={styles.confirmationBody}>{children}</div>
        <div style={styles.confirmationFooter}>{actions}</div>
      </div>
    </div>,
    document.body,
  )
}

function RevertConfirmation({
  preview,
  acknowledged,
  disabled,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
}: {
  preview?: GitRevertPreview
  acknowledged: boolean
  disabled: boolean
  onAcknowledgedChange: (value: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element | null {
  if (preview === undefined) return null
  return (
    <ReviewConfirmationDialog
      title={`Revert ${preview.path}?`}
      descriptionId="git-revert-description"
      closeLabel="Close revert confirmation"
      disabled={disabled}
      onCancel={onCancel}
      actions={(
        <>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onCancel}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={disabled || !acknowledged} onClick={onConfirm}>
            Revert file
          </Button>
        </>
      )}
    >
      <div id="git-revert-description" style={styles.confirmationWarning}>
        <IconWarningOutline16 />
        <span>
          This restores the exact unstaged file shown in Review from the Git index. The approval expires at{' '}
          {new Date(preview.expiresAt).toLocaleTimeString()}.
        </span>
      </div>
      <label style={styles.confirmationAcknowledge}>
        <input
          autoFocus
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          onChange={event => onAcknowledgedChange(event.currentTarget.checked)}
        />
        <span>I understand these unstaged changes cannot be recovered by DSH Desktop.</span>
      </label>
    </ReviewConfirmationDialog>
  )
}

function CommitConfirmation({
  preview,
  message,
  disabled,
  onMessageChange,
  onCancel,
  onConfirm,
}: {
  preview?: GitCommitPreview
  message: string
  disabled: boolean
  onMessageChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element | null {
  if (preview === undefined) return null
  const fileCount = preview.review.files.length
  return (
    <ReviewConfirmationDialog
      title={`Commit ${String(fileCount)} staged ${fileCount === 1 ? 'file' : 'files'}?`}
      descriptionId="git-commit-description"
      closeLabel="Close commit confirmation"
      disabled={disabled}
      onCancel={onCancel}
      actions={(
        <>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconCheckOutline16 />}
            disabled={disabled || message.trim() === ''}
            onClick={onConfirm}
          >
            Commit
          </Button>
        </>
      )}
    >
      <div id="git-commit-description" style={styles.confirmationSummary}>
        <IconBranchOutline16 />
        <span>
          This commit is bound to the staged changes shown in Review and expires at{' '}
          {new Date(preview.expiresAt).toLocaleTimeString()}.
        </span>
      </div>
      <textarea
        autoFocus
        aria-label="Commit message"
        placeholder="Commit message"
        style={styles.commitMessageInput}
        value={message}
        maxLength={8_192}
        disabled={disabled}
        spellCheck
        onChange={event => onMessageChange(event.currentTarget.value)}
      />
    </ReviewConfirmationDialog>
  )
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
  const [mutationNotice, setMutationNotice] = useState<string>()
  const [commitPreview, setCommitPreview] = useState<GitCommitPreview>()
  const [commitMessage, setCommitMessage] = useState('')
  const [pendingCommit, setPendingCommit] = useState<'preview' | 'confirm'>()
  const [revertPreview, setRevertPreview] = useState<GitRevertPreview>()
  const [revertAcknowledged, setRevertAcknowledged] = useState(false)
  const [pendingRevert, setPendingRevert] = useState<'preview' | 'confirm'>()

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
    setMutationNotice(undefined)
    setCommitPreview(undefined)
    setCommitMessage('')
    setRevertPreview(undefined)
    setRevertAcknowledged(false)
    setRequestedScope({ ...scope })
  }

  const mutateSelected = (): void => {
    if (bridge === undefined || workspaceRoot === undefined || snapshot === undefined || selected === undefined ||
      (snapshot.scope.kind !== 'unstaged' && snapshot.scope.kind !== 'staged')) return
    const kind = snapshot.scope.kind === 'unstaged' ? 'stage' : 'unstage'
    setPendingMutation(kind)
    setMutationError(undefined)
    setMutationNotice(undefined)
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

  const previewStagedCommit = (): void => {
    if (bridge === undefined || workspaceRoot === undefined || snapshot?.scope.kind !== 'staged' ||
      snapshot.files.length === 0) return
    setPendingCommit('preview')
    setMutationError(undefined)
    setMutationNotice(undefined)
    void bridge.previewCommit({ sessionId, workspaceRoot }).then(preview => {
      setSnapshot(preview.review)
      setSelectedPath(previous => preview.review.files.some(file => file.path === previous)
        ? previous
        : preview.review.files[0]?.path)
      setCommitPreview(preview)
      setCommitMessage('')
    }).catch(cause => {
      setMutationError(reviewErrorMessage(cause))
      setRequestedScope({ kind: 'staged' })
    }).finally(() => setPendingCommit(undefined))
  }

  const confirmStagedCommit = (): void => {
    if (bridge === undefined || workspaceRoot === undefined || commitPreview === undefined ||
      commitMessage.trim() === '') return
    setPendingCommit('confirm')
    setMutationError(undefined)
    setMutationNotice(undefined)
    void bridge.confirmCommit({
      sessionId,
      workspaceRoot,
      previewId: commitPreview.previewId,
      message: commitMessage,
      confirmed: true,
    }).then(result => {
      setMutationNotice(`Created commit ${result.commit.slice(0, 12)}.`)
      setCommitPreview(undefined)
      setCommitMessage('')
      setRequestedScope({ kind: 'staged' })
    }).catch(cause => {
      setMutationError(reviewErrorMessage(cause))
      setCommitPreview(undefined)
      setCommitMessage('')
      setRequestedScope({ kind: 'staged' })
    }).finally(() => setPendingCommit(undefined))
  }

  const previewSelectedRevert = (): void => {
    if (bridge === undefined || workspaceRoot === undefined || snapshot?.scope.kind !== 'unstaged' ||
      selected === undefined || !canRevert(selected)) return
    setPendingRevert('preview')
    setMutationError(undefined)
    setMutationNotice(undefined)
    void bridge.previewRevert({ sessionId, workspaceRoot, path: selected.path }).then(preview => {
      setSnapshot(preview.review)
      setSelectedPath(preview.path)
      setRevertPreview(preview)
      setRevertAcknowledged(false)
    }).catch(cause => {
      setMutationError(reviewErrorMessage(cause))
      setRequestedScope({ ...snapshot.scope })
    }).finally(() => setPendingRevert(undefined))
  }

  const confirmSelectedRevert = (): void => {
    if (bridge === undefined || workspaceRoot === undefined || revertPreview === undefined ||
      !revertAcknowledged) return
    setPendingRevert('confirm')
    setMutationError(undefined)
    setMutationNotice(undefined)
    void bridge.confirmRevert({
      sessionId,
      workspaceRoot,
      previewId: revertPreview.previewId,
      confirmed: true,
    }).then(() => {
      setMutationError(undefined)
      setRevertPreview(undefined)
      setRevertAcknowledged(false)
      setRequestedScope({ kind: 'unstaged' })
    }).catch(cause => {
      setMutationError(reviewErrorMessage(cause))
      setRevertPreview(undefined)
      setRevertAcknowledged(false)
      setRequestedScope({ kind: 'unstaged' })
    }).finally(() => setPendingRevert(undefined))
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
          disabled={pendingMutation !== undefined || pendingCommit !== undefined || pendingRevert !== undefined}
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
            disabled={pendingMutation !== undefined || pendingCommit !== undefined || pendingRevert !== undefined}
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
            disabled={pendingMutation !== undefined || pendingCommit !== undefined || pendingRevert !== undefined}
            spellCheck={false}
            onChange={event => setBaseRef(event.currentTarget.value)}
          />
        )}
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRefreshOutline16 />}
          disabled={loading || pendingMutation !== undefined || pendingCommit !== undefined ||
            pendingRevert !== undefined}
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
          {mutationNotice !== undefined && <div role="status" style={styles.notice}>{mutationNotice}</div>}
          {mutationError !== undefined && <div role="alert" style={styles.state}>{mutationError}</div>}
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
                {snapshot.scope.kind === 'staged' && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<IconCheckOutline16 />}
                    disabled={loading || pendingMutation !== undefined || pendingCommit !== undefined ||
                      pendingRevert !== undefined}
                    title="Preview and commit all staged files"
                    onClick={previewStagedCommit}
                  >
                    Commit
                  </Button>
                )}
                {(snapshot.scope.kind === 'unstaged' || snapshot.scope.kind === 'staged') && (
                  <Button
                    size="sm"
                    variant="toolbar"
                    icon={<IconBranchOutline16 />}
                    disabled={loading || pendingMutation !== undefined || pendingCommit !== undefined ||
                      pendingRevert !== undefined}
                    title={snapshot.scope.kind === 'unstaged' ? 'Stage selected file' : 'Unstage selected file'}
                    onClick={mutateSelected}
                  >
                    {snapshot.scope.kind === 'unstaged' ? 'Stage' : 'Unstage'}
                  </Button>
                )}
                {snapshot.scope.kind === 'unstaged' && canRevert(selected) && (
                  <Button
                    size="sm"
                    variant="toolbar"
                    icon={<IconTrashOutline16 />}
                    disabled={loading || pendingMutation !== undefined || pendingCommit !== undefined ||
                      pendingRevert !== undefined}
                    title="Preview reverting the selected file"
                    onClick={previewSelectedRevert}
                  >
                    Revert
                  </Button>
                )}
              </div>
            )}
            {mutationNotice !== undefined && <div role="status" style={styles.notice}>{mutationNotice}</div>}
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
      <CommitConfirmation
        preview={commitPreview}
        message={commitMessage}
        disabled={pendingCommit === 'confirm'}
        onMessageChange={setCommitMessage}
        onCancel={() => {
          if (pendingCommit === 'confirm') return
          setCommitPreview(undefined)
          setCommitMessage('')
        }}
        onConfirm={confirmStagedCommit}
      />
      <RevertConfirmation
        preview={revertPreview}
        acknowledged={revertAcknowledged}
        disabled={pendingRevert === 'confirm'}
        onAcknowledgedChange={setRevertAcknowledged}
        onCancel={() => {
          if (pendingRevert === 'confirm') return
          setRevertPreview(undefined)
          setRevertAcknowledged(false)
        }}
        onConfirm={confirmSelectedRevert}
      />
    </section>
  )
}
