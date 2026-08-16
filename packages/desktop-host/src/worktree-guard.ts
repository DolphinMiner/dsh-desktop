import { isAbsolute, relative, sep } from 'node:path'

import type {
  WorktreeChangedEvent,
  WorktreeSnapshot,
  WorktreeSummary,
} from '@dolphinminer/dsh-desktop-protocol'

export interface WorktreeSessionClaim {
  managed: boolean
  recordId?: string
}

export class WorktreeSessionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeSessionConflictError'
  }
}

function checkoutPath(worktree: WorktreeSummary): string {
  return worktree.executionMode === 'local' ? worktree.repositoryRoot : worktree.worktreePath!
}

function containsPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export class WorktreeSessionGuard {
  private revision = -1
  private readonly worktrees = new Map<string, WorktreeSummary>()

  applySnapshot(snapshot: WorktreeSnapshot): boolean {
    if (snapshot.revision <= this.revision) return false
    this.revision = snapshot.revision
    this.worktrees.clear()
    for (const worktree of snapshot.worktrees) {
      if (worktree.lifecycle !== 'removed') this.worktrees.set(worktree.id, { ...worktree })
    }
    return true
  }

  applyChange(event: WorktreeChangedEvent): boolean {
    if (event.revision <= this.revision) return false
    this.revision = event.revision
    if (event.worktree.lifecycle === 'removed') this.worktrees.delete(event.worktree.id)
    else this.worktrees.set(event.worktree.id, { ...event.worktree })
    return true
  }

  claim(sessionId: string, workspacePath: string): WorktreeSessionClaim {
    const worktree = [...this.worktrees.values()]
      .filter(item => containsPath(checkoutPath(item), workspacePath))
      .sort((left, right) => checkoutPath(right).length - checkoutPath(left).length)[0]
    if (worktree === undefined) return { managed: false }
    if (worktree.sessionId === sessionId) return { managed: true, recordId: worktree.id }
    if (worktree.sessionId !== undefined) {
      throw new WorktreeSessionConflictError(
        'This managed checkout is already assigned to another Harness session.',
      )
    }
    if (worktree.lifecycle !== 'ready') {
      throw new WorktreeSessionConflictError(
        'This managed checkout requires recovery before a Harness session can use it.',
      )
    }
    this.worktrees.set(worktree.id, {
      ...worktree,
      sessionState: 'bound',
      sessionId,
    })
    return { managed: true, recordId: worktree.id }
  }
}
