import { createHash } from 'node:crypto'

import type { GitReviewSnapshot } from '@dolphinminer/dsh-desktop-protocol'

export function gitReviewFingerprint(review: GitReviewSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    repository: review.repository,
    scope: review.scope,
    head: review.head,
    files: review.files,
    patch: review.patch,
  })).digest('hex')
}
