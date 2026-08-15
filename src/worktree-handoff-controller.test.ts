import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  WorktreeHandoffPreflight,
} from '@dolphinminer/dsh-desktop-protocol'

import { writeJsonAtomically } from './atomic-json'
import { GitRepositoryMutationQueue } from './git-index-controller'
import {
  WorktreeHandoffController,
  WorktreeHandoffControllerError,
  type WorktreeHandoffOperations,
} from './worktree-handoff-controller'
import {
  WorktreeHandoffJournal,
  worktreeHandoffOperationPhase,
} from './worktree-handoff-journal'
import type {
  ManagedWorktreeHandoffExpectation,
  ManagedWorktreeHandoffTransferResult,
  WorktreeHandoffState,
} from './worktree-manager'
import type { WorktreeRecord } from './worktree-registry'

const previewId = '11111111-1111-4111-8111-111111111111'
const worktreeId = '22222222-2222-4222-8222-222222222222'

const record: WorktreeRecord = {
  id: worktreeId,
  repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' },
  requestedBySessionId: 'request-session',
  sessionId: 'worktree-session',
  executionMode: 'worktree',
  worktreePath: '/managed/worktree',
  baseRef: 'refs/heads/main',
  baseCommit: 'a'.repeat(40),
  branch: 'refs/heads/dsh/session-123456789012345678901234',
  lifecycle: 'ready',
  creationOperationId: 'create-worktree',
  createdAt: '2026-08-16T12:00:00.000Z',
  updatedAt: '2026-08-16T12:00:01.000Z',
}

function preflight(overrides: Partial<WorktreeHandoffPreflight> = {}): WorktreeHandoffPreflight {
  return {
    direction: 'local-to-worktree',
    worktree: {
      id: record.id,
      repositoryRoot: record.repository.root,
      requestedBySessionId: record.requestedBySessionId,
      sessionState: 'bound',
      sessionId: record.sessionId,
      executionMode: 'worktree',
      worktreePath: record.worktreePath,
      baseRef: record.baseRef,
      baseCommit: record.baseCommit,
      branch: record.branch,
      lifecycle: 'ready',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    baseCommit: record.baseCommit,
    sourceTree: 'b'.repeat(40),
    source: { kind: 'local', path: '/repo', branch: 'main', head: 'c'.repeat(40), clean: false },
    destination: {
      kind: 'worktree',
      path: '/managed/worktree',
      branch: 'dsh/session-123456789012345678901234',
      head: record.baseCommit,
      clean: true,
    },
    files: [{ status: 'modified', path: 'README.md', patchAvailable: true }],
    patch: 'diff --git a/README.md b/README.md\n-reviewed\n+approved\n',
    blockers: [],
    canTransfer: true,
    ...overrides,
  }
}

function state(value = preflight()): WorktreeHandoffState {
  return { record: { ...record, repository: { ...record.repository } }, preflight: value }
}

class FakeWorktrees implements WorktreeHandoffOperations {
  inspections: WorktreeHandoffState[] = []
  defaultState = state()
  transferCalls = 0
  outcomeCalls = 0
  outcome: 'completed' | 'not-applied' | 'ambiguous' = 'completed'
  transferError?: Error
  beforeBoundary?: () => void
  holdTransfer?: Promise<void>
  transferredExpectation?: ManagedWorktreeHandoffExpectation

  async inspectHandoff(): Promise<WorktreeHandoffState> {
    return this.inspections.shift() ?? this.defaultState
  }

  async transferHandoff(
    _id: string,
    expected: ManagedWorktreeHandoffExpectation,
    _signal: AbortSignal,
    beforeDispatch?: (record: WorktreeRecord) => void,
  ): Promise<ManagedWorktreeHandoffTransferResult> {
    this.transferCalls += 1
    this.transferredExpectation = expected
    this.beforeBoundary?.()
    beforeDispatch?.(record)
    if (this.holdTransfer !== undefined) await this.holdTransfer
    if (this.transferError !== undefined) throw this.transferError
    return {
      record,
      result: {
        sourceTree: expected.sourceTree,
        destination: {
          repository: record.repository,
          head: record.baseCommit,
          branch: expected.destinationBranch,
          ahead: 0,
          behind: 0,
          clean: false,
          entries: [{
            kind: 'ordinary',
            path: 'README.md',
            indexStatus: 'M',
            worktreeStatus: '.',
          }],
        },
      },
    }
  }

  async inspectHandoffOutcome(): Promise<'completed' | 'not-applied' | 'ambiguous'> {
    this.outcomeCalls += 1
    return this.outcome
  }
}

async function fixture(options: {
  worktrees?: FakeWorktrees
  journal?: WorktreeHandoffJournal
  now?: () => Date
  approve?: () => Promise<boolean>
  isSessionRunning?: (sessionId: string) => boolean
  isPathRunning?: (path: string) => boolean
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-controller-test-'))
  const worktrees = options.worktrees ?? new FakeWorktrees()
  const journal = options.journal ?? new WorktreeHandoffJournal(join(root, 'handoffs.json'))
  const controller = new WorktreeHandoffController(
    worktrees,
    journal,
    new GitRepositoryMutationQueue(),
    {
      randomId: () => previewId,
      now: options.now,
      approve: options.approve ?? (async () => true),
      isSessionRunning: options.isSessionRunning,
      isPathRunning: options.isPathRunning,
    },
  )
  return { root, worktrees, journal, controller }
}

test('binds dual approval to one exact handoff and returns a successful retry without replay', async t => {
  let approvalDetails: object | undefined
  const setup = await fixture({
    approve: async () => {
      approvalDetails = {
        approved: true,
      }
      return true
    },
  })
  t.after(() => rm(setup.root, { recursive: true, force: true }))
  const signal = new AbortController().signal

  const preview = await setup.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  assert.equal(preview.previewId, previewId)
  assert.equal(preview.preflight.sourceTree, 'b'.repeat(40))
  const result = await setup.controller.confirm({ previewId, confirmed: true }, signal)

  assert.deepEqual(result, {
    operationId: previewId,
    direction: 'local-to-worktree',
    sourceTree: 'b'.repeat(40),
  })
  assert.deepEqual(approvalDetails, { approved: true })
  assert.equal(setup.worktrees.transferCalls, 1)
  assert.deepEqual(setup.worktrees.transferredExpectation, {
    direction: 'local-to-worktree',
    baseCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    sourceHead: 'c'.repeat(40),
    sourceBranch: 'main',
    destinationBranch: 'dsh/session-123456789012345678901234',
  })
  const operation = setup.journal.get(previewId)!
  assert.equal(worktreeHandoffOperationPhase(operation), 'succeeded')
  assert.equal(operation.files[0]?.path, 'README.md')
  assert.match(operation.patchFingerprint, /^[a-f0-9]{64}$/)
  assert.match(operation.approvalFingerprint, /^[a-f0-9]{64}$/)

  assert.deepEqual(await setup.controller.confirm({ previewId, confirmed: true }, signal), result)
  assert.equal(setup.worktrees.transferCalls, 1)
})

test('rejects blockers, expiry, and native denial before persisting intent', async t => {
  const blockedWorktrees = new FakeWorktrees()
  blockedWorktrees.defaultState = state(preflight({
    blockers: ['destination-dirty'],
    canTransfer: false,
  }))
  let approvals = 0
  const blocked = await fixture({
    worktrees: blockedWorktrees,
    approve: async () => { approvals += 1; return true },
  })
  t.after(() => rm(blocked.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await blocked.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(blocked.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /blocked/.test(error.message))
  assert.equal(approvals, 0)
  assert.equal(blocked.journal.get(previewId), undefined)

  let timestamp = Date.parse('2026-08-16T12:00:00.000Z')
  const expired = await fixture({ now: () => new Date(timestamp) })
  t.after(() => rm(expired.root, { recursive: true, force: true }))
  await expired.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  timestamp += 11 * 60_000
  await assert.rejects(expired.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /expired/.test(error.message))
  assert.equal(expired.journal.get(previewId), undefined)

  const denied = await fixture({ approve: async () => false })
  t.after(() => rm(denied.root, { recursive: true, force: true }))
  await denied.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(denied.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CANCELLED')
  assert.equal(denied.journal.get(previewId), undefined)
})

test('revalidates the complete handoff before and after native approval', async t => {
  const changed = preflight({ patch: `${preflight().patch}changed\n`, sourceTree: 'd'.repeat(40) })
  const beforeWorktrees = new FakeWorktrees()
  beforeWorktrees.inspections = [state(), state(changed)]
  const before = await fixture({ worktrees: beforeWorktrees })
  t.after(() => rm(before.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await before.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(before.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /after preview/.test(error.message))
  assert.equal(before.journal.get(previewId), undefined)

  const duringWorktrees = new FakeWorktrees()
  duringWorktrees.inspections = [state(), state(), state(changed)]
  const during = await fixture({ worktrees: duringWorktrees })
  t.after(() => rm(during.root, { recursive: true, force: true }))
  await during.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(during.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /during approval/.test(error.message))
  assert.equal(during.journal.get(previewId), undefined)
})

test('blocks active checkout paths including a session that starts at final dispatch', async t => {
  const activeAtPreview = await fixture({ isPathRunning: path => path === '/repo' })
  t.after(() => rm(activeAtPreview.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await assert.rejects(activeAtPreview.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /active Harness/.test(error.message))

  let active = false
  const worktrees = new FakeWorktrees()
  worktrees.beforeBoundary = () => { active = true }
  const final = await fixture({ worktrees, isPathRunning: () => active })
  t.after(() => rm(final.root, { recursive: true, force: true }))
  await final.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(final.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /active Harness/.test(error.message))
  assert.equal(worktreeHandoffOperationPhase(final.journal.get(previewId)!), 'cancelled')
})

test('reconciles a dispatched failure and never replays an ambiguous transfer', async t => {
  const completedWorktrees = new FakeWorktrees()
  completedWorktrees.transferError = new Error('timeout after apply')
  completedWorktrees.outcome = 'completed'
  const completed = await fixture({ worktrees: completedWorktrees })
  t.after(() => rm(completed.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await completed.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  assert.equal((await completed.controller.confirm({ previewId, confirmed: true }, signal)).sourceTree, 'b'.repeat(40))
  assert.equal(worktreeHandoffOperationPhase(completed.journal.get(previewId)!), 'succeeded')

  const untouchedWorktrees = new FakeWorktrees()
  untouchedWorktrees.transferError = new Error('rejected before apply acknowledgement')
  untouchedWorktrees.outcome = 'not-applied'
  const untouched = await fixture({ worktrees: untouchedWorktrees })
  t.after(() => rm(untouched.root, { recursive: true, force: true }))
  await untouched.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(untouched.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /not applied/.test(error.message))
  assert.equal(worktreeHandoffOperationPhase(untouched.journal.get(previewId)!), 'failed')

  const ambiguousWorktrees = new FakeWorktrees()
  ambiguousWorktrees.transferError = new Error('timeout with partial state')
  ambiguousWorktrees.outcome = 'ambiguous'
  const ambiguous = await fixture({ worktrees: ambiguousWorktrees })
  t.after(() => rm(ambiguous.root, { recursive: true, force: true }))
  await ambiguous.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(ambiguous.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /ambiguous/.test(error.message))
  assert.equal(worktreeHandoffOperationPhase(ambiguous.journal.get(previewId)!), 'ambiguous')
  await assert.rejects(ambiguous.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /ambiguous/.test(error.message))
  assert.equal(ambiguousWorktrees.transferCalls, 1)
})

test('fails closed when dispatch or successful outcome persistence fails', async t => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-dispatch-write-test-'))
  t.after(() => rm(firstRoot, { recursive: true, force: true }))
  let dispatchWrites = 0
  const dispatchJournal = new WorktreeHandoffJournal(join(firstRoot, 'handoffs.json'), {
    write: (path, value) => {
      dispatchWrites += 1
      if (dispatchWrites === 2) throw new Error('disk full')
      writeJsonAtomically(path, value)
    },
  })
  const dispatch = await fixture({ journal: dispatchJournal })
  t.after(() => rm(dispatch.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await dispatch.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(dispatch.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal(dispatch.journal.status().available, false)

  const secondRoot = await mkdtemp(join(tmpdir(), 'dsh-worktree-handoff-outcome-write-test-'))
  t.after(() => rm(secondRoot, { recursive: true, force: true }))
  let outcomeWrites = 0
  const outcomeJournal = new WorktreeHandoffJournal(join(secondRoot, 'handoffs.json'), {
    write: (path, value) => {
      outcomeWrites += 1
      if (outcomeWrites === 3) throw new Error('disk full')
      writeJsonAtomically(path, value)
    },
  })
  const outcome = await fixture({ journal: outcomeJournal })
  t.after(() => rm(outcome.root, { recursive: true, force: true }))
  await outcome.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)
  await assert.rejects(outcome.controller.confirm({ previewId, confirmed: true }, signal),
    (error: WorktreeHandoffControllerError) => error.code === 'CONFLICT' && /durable outcome/.test(error.message))
  assert.equal(outcome.worktrees.transferCalls, 1)
  assert.equal(outcome.journal.status().available, false)
})

test('serializes concurrent confirmation and dispatches one transfer', async t => {
  let release: (() => void) | undefined
  const worktrees = new FakeWorktrees()
  worktrees.holdTransfer = new Promise<void>(resolve => { release = resolve })
  const setup = await fixture({ worktrees })
  t.after(() => rm(setup.root, { recursive: true, force: true }))
  const signal = new AbortController().signal
  await setup.controller.preview({ worktreeId, direction: 'local-to-worktree' }, signal)

  const first = setup.controller.confirm({ previewId, confirmed: true }, signal)
  while (worktrees.transferCalls === 0) await new Promise(resolve => setTimeout(resolve, 1))
  const second = setup.controller.confirm({ previewId, confirmed: true }, signal)
  release?.()
  assert.deepEqual(await first, await second)
  assert.equal(worktrees.transferCalls, 1)
})
