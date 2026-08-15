import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopWorktreeRecoveryConfirmInput,
  parseDesktopWorktreeRecoveryPreviewInput,
  parseWorktreeRecoveryPreview,
  parseWorktreeRecoveryResult,
} from './worktree-recovery.js'

const worktreeId = '11111111-1111-4111-8111-111111111111'
const previewId = '22222222-2222-4222-8222-222222222222'
const worktree = {
  id: worktreeId,
  repositoryRoot: '/repo',
  requestedBySessionId: 'request-session',
  sessionState: 'pending' as const,
  executionMode: 'worktree' as const,
  worktreePath: '/managed/worktree',
  baseRef: 'refs/heads/main',
  baseCommit: 'a'.repeat(40),
  branch: 'refs/heads/dsh/session-123456789012345678901234',
  lifecycle: 'recovery-required' as const,
  recoveryReason: 'interrupted-remove' as const,
  createdAt: '2026-08-16T12:00:00.000Z',
  updatedAt: '2026-08-16T12:01:00.000Z',
}
const inspection = {
  worktreePath: worktree.worktreePath,
  head: 'b'.repeat(40),
  branch: worktree.branch,
  clean: false as const,
  locked: true as const,
  changes: [{
    kind: 'untracked' as const,
    path: 'notes.txt',
    indexStatus: '?',
    worktreeStatus: '?',
  }],
}

test('validates the supported worktree recovery actions and explicit confirmation', () => {
  assert.deepEqual(parseDesktopWorktreeRecoveryPreviewInput({
    worktreeId,
    action: 'keep-interrupted-removal',
  }), { worktreeId, action: 'keep-interrupted-removal' })
  assert.deepEqual(parseDesktopWorktreeRecoveryPreviewInput({
    worktreeId,
    action: 'forget-missing',
  }), { worktreeId, action: 'forget-missing' })
  assert.deepEqual(parseDesktopWorktreeRecoveryPreviewInput({
    worktreeId,
    action: 'restore-moved',
  }), { worktreeId, action: 'restore-moved' })
  assert.deepEqual(parseDesktopWorktreeRecoveryPreviewInput({
    worktreeId,
    action: 'stop-tracking',
  }), { worktreeId, action: 'stop-tracking' })
  assert.equal(parseDesktopWorktreeRecoveryPreviewInput({
    worktreeId,
    action: 'retry-removal',
  }), undefined)
  assert.deepEqual(parseDesktopWorktreeRecoveryConfirmInput({ previewId, confirmed: true }), {
    previewId,
    confirmed: true,
  })
  assert.equal(parseDesktopWorktreeRecoveryConfirmInput({ previewId, confirmed: false }), undefined)
})

test('binds a keep preview to exact interrupted-removal evidence', () => {
  const preview = {
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    action: 'keep-interrupted-removal' as const,
    worktree,
    inspection,
  }
  assert.deepEqual(parseWorktreeRecoveryPreview(preview), preview)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    worktree: { ...worktree, recoveryReason: 'missing' },
  }), undefined)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: { ...inspection, worktreePath: '/other' },
  }), undefined)
})

test('accepts only a recovered ready or orphaned worktree result', () => {
  const { recoveryReason: _recoveryReason, ...recoveredWorktree } = worktree
  const result = {
    resolutionId: previewId,
    action: 'keep-interrupted-removal' as const,
    worktree: {
      ...recoveredWorktree,
      lifecycle: 'orphaned' as const,
    },
  }
  assert.deepEqual(parseWorktreeRecoveryResult(result), result)
  assert.equal(parseWorktreeRecoveryResult({
    ...result,
    worktree,
  }), undefined)
})

test('binds forgetting a missing checkout to exact absent metadata and path evidence', () => {
  const missingWorktree = {
    ...worktree,
    recoveryReason: 'missing' as const,
  }
  const missingInspection = {
    repositoryRoot: missingWorktree.repositoryRoot,
    worktreePath: missingWorktree.worktreePath,
    branch: missingWorktree.branch,
    worktreeMetadataAbsent: true as const,
    checkoutPathAbsent: true as const,
  }
  const preview = {
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    action: 'forget-missing' as const,
    worktree: missingWorktree,
    inspection: missingInspection,
  }
  assert.deepEqual(parseWorktreeRecoveryPreview(preview), preview)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: { ...missingInspection, checkoutPathAbsent: false },
  }), undefined)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: { ...missingInspection, branch: 'refs/heads/other' },
  }), undefined)

  const { recoveryReason: _recoveryReason, ...forgottenWorktree } = missingWorktree
  const result = {
    resolutionId: previewId,
    action: 'forget-missing' as const,
    worktree: { ...forgottenWorktree, lifecycle: 'removed' as const },
  }
  assert.deepEqual(parseWorktreeRecoveryResult(result), result)
  assert.equal(parseWorktreeRecoveryResult({
    ...result,
    worktree: { ...forgottenWorktree, lifecycle: 'orphaned' },
  }), undefined)
})

test('binds restoring a moved checkout to both exact paths and preserved Git state', () => {
  const movedWorktree = {
    ...worktree,
    recoveryReason: 'moved' as const,
  }
  const movedInspection = {
    repositoryRoot: movedWorktree.repositoryRoot,
    registeredPath: movedWorktree.worktreePath,
    current: {
      ...inspection,
      worktreePath: '/managed/moved',
    },
    registeredPathAbsent: true as const,
  }
  const preview = {
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    action: 'restore-moved' as const,
    worktree: movedWorktree,
    inspection: movedInspection,
  }
  assert.deepEqual(parseWorktreeRecoveryPreview(preview), preview)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: { ...movedInspection, registeredPath: '/managed/other' },
  }), undefined)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: {
      ...movedInspection,
      current: { ...movedInspection.current, branch: 'refs/heads/other' },
    },
  }), undefined)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: {
      ...movedInspection,
      current: { ...movedInspection.current, worktreePath: movedInspection.registeredPath },
    },
  }), undefined)

  const { recoveryReason: _recoveryReason, ...recoveredWorktree } = movedWorktree
  const result = {
    resolutionId: previewId,
    action: 'restore-moved' as const,
    worktree: { ...recoveredWorktree, lifecycle: 'orphaned' as const },
  }
  assert.deepEqual(parseWorktreeRecoveryResult(result), result)
  assert.equal(parseWorktreeRecoveryResult({
    ...result,
    worktree: { ...recoveredWorktree, lifecycle: 'recovery-required' },
  }), undefined)
})

test('binds stop tracking to exact external repository and checkout identity evidence', () => {
  const changedWorktree = {
    ...worktree,
    recoveryReason: 'external-change' as const,
  }
  const registeredRepository = {
    root: changedWorktree.repositoryRoot,
    gitDir: '/repo/.git',
    commonDir: '/repo/.git',
  }
  const changedInspection = {
    registeredRepository,
    registeredPath: changedWorktree.worktreePath,
    registeredBranch: changedWorktree.branch,
    checkoutPathPresent: true as const,
    repositoryRootObservation: {
      state: 'matching' as const,
      identity: registeredRepository,
    },
    checkoutObservation: {
      state: 'changed' as const,
      identity: {
        root: changedWorktree.worktreePath,
        gitDir: `${changedWorktree.worktreePath}/.git`,
        commonDir: `${changedWorktree.worktreePath}/.git`,
      },
    },
    registrationObservation: { state: 'missing' as const },
  }
  const preview = {
    previewId,
    expiresAt: '2026-08-16T12:05:00.000Z',
    action: 'stop-tracking' as const,
    worktree: changedWorktree,
    inspection: changedInspection,
  }
  assert.deepEqual(parseWorktreeRecoveryPreview(preview), preview)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: {
      ...changedInspection,
      checkoutObservation: {
        state: 'matching',
        identity: {
          root: changedWorktree.worktreePath,
          gitDir: '/repo/.git/worktrees/managed',
          commonDir: registeredRepository.commonDir,
        },
      },
      registrationObservation: {
        state: 'matching',
        entry: {
          path: changedWorktree.worktreePath,
          head: changedWorktree.baseCommit,
          branch: changedWorktree.branch,
          detached: false,
          bare: false,
          locked: true,
          prunable: false,
        },
      },
    },
  }), undefined)
  assert.equal(parseWorktreeRecoveryPreview({
    ...preview,
    inspection: {
      ...changedInspection,
      checkoutObservation: { ...changedInspection.checkoutObservation, unexpected: true },
    },
  }), undefined)

  const { recoveryReason: _recoveryReason, ...stoppedWorktree } = changedWorktree
  const result = {
    resolutionId: previewId,
    action: 'stop-tracking' as const,
    worktree: { ...stoppedWorktree, lifecycle: 'removed' as const },
  }
  assert.deepEqual(parseWorktreeRecoveryResult(result), result)
  assert.equal(parseWorktreeRecoveryResult({
    ...result,
    worktree: { ...stoppedWorktree, lifecycle: 'orphaned' },
  }), undefined)
})
