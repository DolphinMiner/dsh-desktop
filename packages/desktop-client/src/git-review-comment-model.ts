import type {
  GitReviewAnchorState,
  GitReviewComment,
  GitReviewCommentAnchor,
  ReviewDiffLine,
  ReviewPatchFile,
} from '@dolphinminer/dsh-desktop-protocol'
import { classifyGitReviewAnchor } from '@dolphinminer/dsh-desktop-protocol'

export interface ProjectedGitReviewComment {
  comment: GitReviewComment
  state: GitReviewAnchorState
}

function usableBlob(value: string | undefined): value is string {
  return value !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && !/^0+$/.test(value)
}

export function anchorForDiffLine(
  file: ReviewPatchFile,
  line: ReviewDiffLine,
): GitReviewCommentAnchor | undefined {
  if (line.kind === 'addition' && line.newLine !== undefined && usableBlob(file.newBlob)) {
    return { path: file.path, side: 'new', line: line.newLine, blob: file.newBlob }
  }
  if (line.kind === 'deletion' && line.oldLine !== undefined && usableBlob(file.oldBlob)) {
    return { path: file.path, side: 'old', line: line.oldLine, blob: file.oldBlob }
  }
  if (line.kind === 'context') {
    if (line.newLine !== undefined && usableBlob(file.newBlob)) {
      return { path: file.path, side: 'new', line: line.newLine, blob: file.newBlob }
    }
    if (line.oldLine !== undefined && usableBlob(file.oldBlob)) {
      return { path: file.path, side: 'old', line: line.oldLine, blob: file.oldBlob }
    }
  }
  return undefined
}

export function sameGitReviewAnchor(left: GitReviewCommentAnchor, right: GitReviewCommentAnchor): boolean {
  return left.path === right.path && left.side === right.side && left.line === right.line && left.blob === right.blob
}

export function projectGitReviewComments(
  files: readonly ReviewPatchFile[],
  comments: readonly GitReviewComment[],
): ProjectedGitReviewComment[] {
  return comments.map(comment => ({
    comment,
    state: classifyGitReviewAnchor(files, comment.anchor),
  }))
}
