import { realpath } from 'node:fs/promises'

import type {
  AutomationTaskCenterSnapshot,
  AutomationRunPage,
  DesktopCancelAutomationRunInput,
  DesktopCreateAutomationInput,
  DesktopDeleteAutomationInput,
  DesktopListAutomationRunsInput,
  DesktopQueueAutomationRunInput,
  DesktopSetAutomationStateInput,
  GitRepositoryIdentity,
} from '@dolphinminer/dsh-desktop-protocol'
import { MAX_TASK_CENTER_RECENT_RUNS } from '@dolphinminer/dsh-desktop-protocol'

import { AutomationRegistry, AutomationRegistryError } from './automation-registry'
import { nextAutomationOccurrence } from './automation-schedule'

export interface AutomationControllerGit {
  discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity>
}

export interface AutomationControllerScheduler {
  refresh(): void
}

export interface AutomationControllerOptions {
  canonicalizeProjectPath?: (path: string) => Promise<string>
  onChange?: () => void
  recentRunLimit?: number
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new DOMException('The automation request was cancelled.', 'AbortError')
}

export class AutomationController {
  private readonly canonicalizeProjectPath: (path: string) => Promise<string>
  private readonly onChange?: () => void
  private readonly recentRunLimit: number

  constructor(
    private readonly registry: AutomationRegistry,
    private readonly scheduler: AutomationControllerScheduler,
    private readonly git: AutomationControllerGit,
    options: AutomationControllerOptions = {},
  ) {
    this.canonicalizeProjectPath = options.canonicalizeProjectPath ?? realpath
    this.onChange = options.onChange
    this.recentRunLimit = Math.max(1, Math.min(
      MAX_TASK_CENTER_RECENT_RUNS,
      options.recentRunLimit ?? MAX_TASK_CENTER_RECENT_RUNS,
    ))
  }

  snapshot(): AutomationTaskCenterSnapshot {
    const snapshot = this.registry.snapshot()
    const recentRuns = [...snapshot.runs]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.id.localeCompare(left.id))
      .slice(0, this.recentRunLimit)
    return {
      revision: snapshot.revision,
      automations: snapshot.automations,
      recentRuns,
      totalRunCount: snapshot.runs.length,
      executionAvailability: 'requires-app-running',
    }
  }

  listRuns(input: DesktopListAutomationRunsInput): AutomationRunPage {
    const snapshot = this.registry.snapshot()
    if (snapshot.revision !== input.expectedRevision) {
      throw new AutomationRegistryError('CONFLICT', 'Automation history changed. Refresh Task Center and try again.')
    }
    const runs = [...snapshot.runs].sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id))
    const cursor = runs.findIndex(run => run.id === input.beforeRunId)
    if (cursor < 0) {
      throw new AutomationRegistryError('NOT_FOUND', 'The automation history cursor was not found.')
    }
    const page = runs.slice(cursor + 1, cursor + 1 + input.limit)
    const hasMore = cursor + 1 + page.length < runs.length
    return {
      revision: snapshot.revision,
      runs: page,
      totalRunCount: runs.length,
      ...(hasMore && page.length > 0 ? { nextBeforeRunId: page.at(-1)!.id } : {}),
    }
  }

  async create(input: DesktopCreateAutomationInput, signal?: AbortSignal): Promise<AutomationTaskCenterSnapshot> {
    assertNotAborted(signal)
    const localAcknowledgement = (input.execution as { localCheckoutAcknowledged?: boolean })
      .localCheckoutAcknowledged
    if (input.execution.mode === 'local' && localAcknowledgement !== true) {
      throw new AutomationRegistryError(
        'BAD_MESSAGE',
        'Local checkout execution requires an explicit acknowledgement.',
      )
    }
    const projectPath = await this.canonicalizeProjectPath(input.projectPath)
    assertNotAborted(signal)
    const repository = await this.git.discoverRepository(projectPath, signal)
    const nextTriggerAt = input.trigger.kind === 'once'
      ? input.trigger.at
      : nextAutomationOccurrence(input.trigger, input.requestedAt)
    if (nextTriggerAt === undefined) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation trigger has no future occurrence.')
    }
    const revision = this.registry.status().revision
    this.registry.createDefinition({
      operationId: input.operationId,
      definition: {
        name: input.name,
        prompt: input.prompt,
        projectPath,
        repository,
        trigger: input.trigger,
        execution: input.execution.mode === 'local'
          ? { mode: 'local' }
          : { mode: 'worktree', baseRef: input.execution.baseRef },
        concurrencyPolicy: input.concurrencyPolicy,
        skillIds: input.skillIds,
        connectionIds: input.connectionIds,
        state: 'enabled',
        nextTriggerAt,
      },
    })
    this.afterMutation(revision, true)
    return this.snapshot()
  }

  setState(input: DesktopSetAutomationStateInput): AutomationTaskCenterSnapshot {
    const current = this.registry.getDefinition(input.automationId)
    if (current === undefined) {
      throw new AutomationRegistryError('NOT_FOUND', 'The automation definition was not found.')
    }
    const nextTriggerAt = input.state === 'paused'
      ? undefined
      : current.trigger.kind === 'once'
        ? current.trigger.at
        : nextAutomationOccurrence(current.trigger, input.requestedAt)
    if (input.state === 'enabled' && nextTriggerAt === undefined) {
      throw new AutomationRegistryError('BAD_MESSAGE', 'The automation trigger has no future occurrence.')
    }
    const revision = this.registry.status().revision
    this.registry.setDefinitionState({
      ...input,
      ...(nextTriggerAt === undefined ? {} : { nextTriggerAt }),
    })
    this.afterMutation(revision, true)
    return this.snapshot()
  }

  delete(input: DesktopDeleteAutomationInput): AutomationTaskCenterSnapshot {
    const revision = this.registry.status().revision
    this.registry.deleteDefinition(input)
    this.afterMutation(revision, true)
    return this.snapshot()
  }

  queueRun(input: DesktopQueueAutomationRunInput): AutomationTaskCenterSnapshot {
    const revision = this.registry.status().revision
    this.registry.queueRun({
      operationId: input.operationId,
      automationId: input.automationId,
      invocation: { kind: 'manual' },
      ...(input.retryOfRunId === undefined ? {} : { retryOfRunId: input.retryOfRunId }),
    })
    this.afterMutation(revision, false)
    return this.snapshot()
  }

  cancelRun(input: DesktopCancelAutomationRunInput): AutomationTaskCenterSnapshot {
    const revision = this.registry.status().revision
    this.registry.requestRunCancellation({
      operationId: input.operationId,
      runId: input.runId,
      reason: 'Cancelled from Task Center.',
    })
    this.afterMutation(revision, false)
    return this.snapshot()
  }

  private afterMutation(previousRevision: number, refreshSchedule: boolean): void {
    if (this.registry.status().revision === previousRevision) return
    if (refreshSchedule) this.scheduler.refresh()
    try {
      this.onChange?.()
    } catch {
      // Durable registry state remains authoritative when a renderer or Host wakeup fails.
    }
  }
}
