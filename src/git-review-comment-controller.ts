import type {
  AddGitReviewCommentInput,
  DeleteGitReviewCommentInput,
  DesktopGitReviewCommentsInput,
  GitRepositoryIdentity,
  GitReviewCommentSnapshot,
  GitReviewParams,
  GitReviewSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'
import { classifyGitReviewAnchor, parseGitReviewPatch } from '@dolphinminer/dsh-desktop-protocol'

import type { GitReviewCommentStore } from './git-review-comments'

export interface ReviewWorkspaceGit {
  discover(input: DesktopGitReviewCommentsInput, signal: AbortSignal): Promise<GitRepositoryIdentity>
  review(input: GitReviewParams, signal: AbortSignal): Promise<GitReviewSnapshot>
}

export class GitReviewCommentController {
  constructor(
    private readonly git: ReviewWorkspaceGit,
    private readonly comments: GitReviewCommentStore,
  ) {}

  async list(input: DesktopGitReviewCommentsInput, signal: AbortSignal): Promise<GitReviewCommentSnapshot> {
    const repository = await this.git.discover(input, signal)
    return this.comments.snapshot(repository.commonDir)
  }

  async add(input: AddGitReviewCommentInput, signal: AbortSignal): Promise<GitReviewCommentSnapshot> {
    const repository = await this.git.discover(input, signal)
    const review = await this.git.review({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: repository.root,
      scope: input.scope,
    }, signal)
    const anchorState = classifyGitReviewAnchor(parseGitReviewPatch(review.patch), input.anchor)
    if (anchorState !== 'active') {
      throw new Error('The review changed before this comment could be saved. Refresh and try again.')
    }
    return this.comments.add({
      id: input.requestId,
      repositoryCommonDir: repository.commonDir,
      anchor: input.anchor,
      body: input.body,
    })
  }

  async remove(input: DeleteGitReviewCommentInput, signal: AbortSignal): Promise<GitReviewCommentSnapshot> {
    const repository = await this.git.discover(input, signal)
    return this.comments.remove(repository.commonDir, input.commentId)
  }
}
