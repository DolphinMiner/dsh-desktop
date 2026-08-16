import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import type {
  AutomationClaimNextParams,
  AutomationDispatchClaim,
  AutomationFinishParams,
  AutomationMarkRunningParams,
  AutomationRunSummary,
  DesktopProtocolError,
  GitRepositoryIdentity,
} from '@dolphinminer/dsh-desktop-protocol'

import { AutomationRegistry } from './automation-registry'
import type {
  ProvisionAutomationWorktreeInput,
  ProvisionWorktreeResult,
} from './worktree-manager'

const MAX_DETAIL_LENGTH = 4_096

export interface AutomationRepositoryOperations {
  discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity>
}

export interface AutomationWorktreeProvisioner {
  provisionAutomation(
    input: ProvisionAutomationWorktreeInput,
    signal: AbortSignal,
  ): Promise<ProvisionWorktreeResult>
}

export interface PreparedAutomationWorkspace {
  workspacePath: string
  worktreeId?: string
}

export interface AutomationWorkspacePreparer {
  prepare(run: AutomationRunSummary, signal: AbortSignal): Promise<PreparedAutomationWorkspace>
}

export type ClaimedAutomationDispatch = AutomationDispatchClaim
export type AutomationClaimNextInput = AutomationClaimNextParams
export type AutomationMarkRunningInput = AutomationMarkRunningParams
export type AutomationFinishInput = AutomationFinishParams

export class AutomationDispatcherError extends Error {
  constructor(
    readonly code: DesktopProtocolError['code'],
    message: string,
    readonly ambiguous = false,
  ) {
    super(message)
    this.name = 'AutomationDispatcherError'
  }
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function sameRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  return left.root === right.root && left.gitDir === right.gitDir && left.commonDir === right.commonDir
}

function projectRelativePath(repositoryRoot: string, projectPath: string): string {
  const child = relative(repositoryRoot, projectPath)
  if (child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return child
  throw new AutomationDispatcherError('BAD_MESSAGE', 'The automation project is outside its repository.')
}

function latestDispatch(run: AutomationRunSummary) {
  const event = [...run.events].reverse().find(item => item.type === 'dispatch')
  return event?.type === 'dispatch' ? event : undefined
}

function safeFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The automation workspace could not be prepared.'
  return `Workspace preparation failed: ${message}`.slice(0, MAX_DETAIL_LENGTH)
}

export class AutomationWorkspaceManager {
  constructor(
    private readonly repositories: AutomationRepositoryOperations,
    private readonly worktrees: AutomationWorktreeProvisioner,
  ) {}

  async prepare(run: AutomationRunSummary, signal: AbortSignal): Promise<PreparedAutomationWorkspace> {
    signal.throwIfAborted()
    const projectPath = await this.verifyProject(run, signal)
    if (run.payload.execution.mode === 'local') return { workspacePath: projectPath }

    const result = await this.worktrees.provisionAutomation({
      operationId: `automation-worktree:${run.id}`,
      requestedBySessionId: run.payload.sessionId,
      workspaceRoot: projectPath,
      baseRef: run.payload.execution.baseRef,
      repository: run.payload.repository,
    }, signal)
    if (result.record.worktreePath === undefined || result.record.lifecycle !== 'ready') {
      throw new AutomationDispatcherError(
        'CONFLICT',
        'The automation worktree is not ready for an Agent Session.',
        true,
      )
    }
    const child = projectRelativePath(run.payload.repository.root, projectPath)
    const expectedPath = child === ''
      ? result.record.worktreePath
      : join(result.record.worktreePath, child)
    let workspacePath: string
    try {
      workspacePath = await realpath(expectedPath)
    } catch {
      throw new AutomationDispatcherError(
        'NOT_FOUND',
        'The automation project path does not exist in the managed worktree.',
      )
    }
    if (workspacePath !== expectedPath) {
      throw new AutomationDispatcherError(
        'TARGET_CHANGED',
        'The automation worktree project path resolves to a different location.',
        true,
      )
    }
    return { workspacePath, worktreeId: result.record.id }
  }

  private async verifyProject(run: AutomationRunSummary, signal: AbortSignal): Promise<string> {
    projectRelativePath(run.payload.repository.root, run.payload.projectPath)
    let projectPath: string
    try {
      projectPath = await realpath(run.payload.projectPath)
    } catch {
      throw new AutomationDispatcherError('NOT_FOUND', 'The automation project path is unavailable.')
    }
    if (projectPath !== run.payload.projectPath) {
      throw new AutomationDispatcherError(
        'TARGET_CHANGED',
        'The automation project path resolves to a different location.',
        true,
      )
    }
    const repository = await this.repositories.discoverRepository(projectPath, signal)
    if (!sameRepository(repository, run.payload.repository)) {
      throw new AutomationDispatcherError(
        'TARGET_CHANGED',
        'The automation repository identity changed after the run was reviewed.',
        true,
      )
    }
    return projectPath
  }
}

export class AutomationDispatcher {
  constructor(
    private readonly registry: AutomationRegistry,
    private readonly workspaces: AutomationWorkspacePreparer,
  ) {}

  async claimNext(
    input: AutomationClaimNextInput,
    signal: AbortSignal,
  ): Promise<ClaimedAutomationDispatch | undefined> {
    this.assertHost(input.hostInstanceId)
    signal.throwIfAborted()
    const snapshot = this.registry.snapshot()
    const owned = snapshot.runs.filter(run => latestDispatch(run)?.hostInstanceId === input.hostInstanceId &&
      (run.phase === 'dispatching' || run.phase === 'running'))
    if (owned.length > 1) {
      throw new AutomationDispatcherError(
        'DESKTOP_UNAVAILABLE',
        'The Harness host owns conflicting automation runs.',
        true,
      )
    }
    if (owned[0]?.phase === 'running') {
      throw new AutomationDispatcherError('CONFLICT', 'The Harness host is already running an automation.')
    }
    if (owned[0] !== undefined) return this.claimedDispatch(owned[0])

    const executingAutomationIds = new Set(snapshot.runs.flatMap(run =>
      run.phase === 'dispatching' || run.phase === 'running' ? [run.automationId] : [],
    ))
    const run = snapshot.runs
      .filter(item => item.phase === 'queued' && !item.cancellationRequested &&
        !executingAutomationIds.has(item.automationId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
    if (run === undefined) return undefined

    let workspace: PreparedAutomationWorkspace
    try {
      workspace = await this.workspaces.prepare(run, signal)
    } catch (error) {
      const detail = safeFailureDetail(error)
      this.registry.finishRun({
        operationId: `workspace-failed:${run.id}`,
        runId: run.id,
        outcome: 'failed',
        detail,
      })
      throw new AutomationDispatcherError('CONFLICT', detail)
    }
    const claimed = this.registry.claimRun({
      operationId: `dispatch:${run.id}:${input.hostInstanceId}`,
      runId: run.id,
      hostInstanceId: input.hostInstanceId,
      workspacePath: workspace.workspacePath,
      ...(workspace.worktreeId === undefined ? {} : { worktreeId: workspace.worktreeId }),
    })
    return this.claimedDispatch(claimed)
  }

  markRunning(input: AutomationMarkRunningInput): AutomationRunSummary {
    this.assertHost(input.hostInstanceId)
    const run = this.requireHostRun(input.runId, input.hostInstanceId)
    return this.registry.markRunRunning({
      operationId: `running:${input.runId}:${input.sessionEventSeq}`,
      runId: run.id,
      sessionEventSeq: input.sessionEventSeq,
    })
  }

  finish(input: AutomationFinishInput): AutomationRunSummary {
    this.assertHost(input.hostInstanceId)
    const run = this.requireHostRun(input.runId, input.hostInstanceId)
    return this.registry.finishRun({
      operationId: `terminal:${input.runId}:${input.sessionEventSeq ?? 'none'}:${input.outcome}`,
      runId: run.id,
      outcome: input.outcome,
      ...(input.sessionEventSeq === undefined ? {} : { sessionEventSeq: input.sessionEventSeq }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    })
  }

  recoverAbandonedRuns(): AutomationRunSummary[] {
    return this.registry.recoverAbandonedRuns({
      detail: 'The Harness host stopped before terminal session evidence was recorded.',
    })
  }

  private assertHost(hostInstanceId: string): void {
    if (!isUuid(hostInstanceId)) {
      throw new AutomationDispatcherError('BAD_MESSAGE', 'The Harness host identity is invalid.')
    }
  }

  private requireHostRun(runId: string, hostInstanceId: string): AutomationRunSummary {
    const run = this.registry.getRun(runId)
    if (run === undefined) throw new AutomationDispatcherError('NOT_FOUND', 'The automation run was not found.')
    if (latestDispatch(run)?.hostInstanceId !== hostInstanceId) {
      throw new AutomationDispatcherError('PERMISSION_DENIED', 'This Harness host does not own the automation run.')
    }
    return run
  }

  private claimedDispatch(run: AutomationRunSummary): ClaimedAutomationDispatch {
    const dispatch = latestDispatch(run)
    if (run.phase !== 'dispatching' || dispatch === undefined) {
      throw new AutomationDispatcherError(
        'DESKTOP_UNAVAILABLE',
        'The automation dispatch claim is inconsistent.',
        true,
      )
    }
    return {
      run,
      workspacePath: dispatch.workspacePath,
      ...(dispatch.worktreeId === undefined ? {} : { worktreeId: dispatch.worktreeId }),
    }
  }
}
