import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  isUserInvocable,
  renderSkillContent,
} from '@deepseek-ai/dsh-skill'
import {
  SessionId,
  type SessionEvent,
  type TurnEndReason,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {
  AutomationDispatchClaim,
  AutomationRunSummary,
  AutomationRunTerminalPhase,
  WorktreeSessionBindingResult,
} from '@dolphinminer/dsh-desktop-protocol'

import type { AutomationConnectionScope, McpConnectionSupervisor } from './mcp-supervisor.js'

const MAX_DETAIL_LENGTH = 4_096

export interface AutomationTerminalEvidence {
  outcome: AutomationRunTerminalPhase
  sessionEventSeq?: number
  detail?: string
}

export interface AutomationDesktopClient {
  claimNext(hostInstanceId: string, signal: AbortSignal): Promise<AutomationDispatchClaim | undefined>
  bindSession(sessionId: string, workspacePath: string, signal: AbortSignal): Promise<WorktreeSessionBindingResult>
  markRunning(hostInstanceId: string, runId: string, sessionEventSeq: number): Promise<AutomationRunSummary>
  finish(hostInstanceId: string, runId: string, evidence: AutomationTerminalEvidence): Promise<AutomationRunSummary>
}

export interface AutomationExecutionHandle {
  readonly sessionId: string
  readonly publicationSeq: number
  execute(): Promise<AutomationTerminalEvidence>
  cancel(): void
  dispose(): Promise<void>
}

export interface AutomationSessionExecutor {
  prepare(dispatch: AutomationDispatchClaim, signal: AbortSignal): Promise<AutomationExecutionHandle>
}

export type AutomationRunErrorHandler = (message: string, error: unknown) => void

function boundDetail(value: string): string | undefined {
  const normalized = value.trim()
  if (normalized === '') return undefined
  return normalized.slice(0, MAX_DETAIL_LENGTH)
}

function errorDetail(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${message}`.slice(0, MAX_DETAIL_LENGTH)
}

function isAmbiguousError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'ambiguous' in error && error.ambiguous === true
}

function terminalFromReason(reason: TurnEndReason, text: string): Omit<AutomationTerminalEvidence, 'sessionEventSeq'> {
  if (reason.kind === 'completed') {
    const detail = boundDetail(text)
    return { outcome: 'succeeded', ...(detail === undefined ? {} : { detail }) }
  }
  if (reason.kind === 'error') {
    return {
      outcome: 'failed',
      detail: boundDetail(`${reason.error.code}: ${reason.error.message}`) ?? 'The Agent turn failed.',
    }
  }
  if (reason.kind === 'blocked') {
    return { outcome: 'failed', detail: 'The Agent turn was blocked before completion.' }
  }
  if (reason.kind === 'max-tokens') {
    return { outcome: 'failed', detail: 'The Agent turn reached its output token limit.' }
  }
  if (reason.kind === 'interrupted') {
    return { outcome: 'interrupted', detail: 'The persisted Agent turn was interrupted.' }
  }
  if (reason.kind === 'aborted') {
    return reason.reason.kind === 'user'
      ? { outcome: 'cancelled', detail: 'The automation was cancelled by the user.' }
      : { outcome: 'interrupted', detail: `The Agent turn was aborted (${reason.reason.kind}).` }
  }
  return { outcome: 'ambiguous', detail: 'The Agent returned an unsupported terminal reason.' }
}

export function summarizeAutomationEvents(
  events: readonly SessionEvent[],
  firstSeq: number,
): AutomationTerminalEvidence {
  const starts = new Set<number>()
  let text = ''
  let terminal: Extract<SessionEvent, { type: 'turn/end' }> | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      starts.add(event.data.turn)
      continue
    }
    if (event.type === 'assistant/message') {
      const next = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (next !== '') text = next
      continue
    }
    if (event.type === 'turn/end' && starts.has(event.data.turn)) terminal = event
  }
  if (terminal === undefined) {
    return {
      outcome: 'ambiguous',
      detail: 'The Agent became idle without a matching durable turn/end event.',
    }
  }
  return {
    ...terminalFromReason(terminal.data.reason, text),
    sessionEventSeq: terminal.seq,
  }
}

async function selectedSkillMessages(
  agentCtx: Context,
  names: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  if (names.length === 0) return []
  const agent = agentCtx.agent
  if (agent === undefined) throw new Error('The unpublished Agent scope has no Agent identity.')
  const lookup = { cwd, signal, scope: agent }
  const snapshot = await agentCtx.skills.snapshot(lookup)
  signal.throwIfAborted()
  if (!snapshot.complete) throw new Error('The selected Skill catalog is not authoritative yet.')
  const summaries = new Map(snapshot.skills.map(skill => [skill.name, skill]))
  const messages: UserMessage[] = []
  for (const name of names) {
    const summary = summaries.get(name)
    if (summary === undefined || !isUserInvocable(summary)) {
      throw new Error(`Selected Skill "${name}" is unavailable for user invocation.`)
    }
    const skill = await agentCtx.skills.get(name, lookup)
    signal.throwIfAborted()
    if (skill === undefined || !isUserInvocable(skill)) {
      throw new Error(`Selected Skill "${name}" changed before the Agent Session was created.`)
    }
    messages.push(createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(skill) }],
      source: { kind: 'skill-invocation', name, form: 'instructions' },
    }))
  }
  return messages
}

function installConnectionScope(agentCtx: Context, scope: AutomationConnectionScope): void {
  if (scope.deniedToolNames.length > 0) {
    agentCtx.tools.restrict({ deny: scope.deniedToolNames })
  }
  agentCtx.tools.guard(execution => {
    if (!execution.name.startsWith('mcp__')) return undefined
    if (scope.allowedPrefixes.some(prefix => execution.name.startsWith(prefix))) return undefined
    return 'This MCP connection was not selected for the automation.'
  })
}

class HarnessAutomationExecution implements AutomationExecutionHandle {
  readonly publicationSeq: number

  constructor(
    private readonly ctx: Context,
    private readonly handle: AgentHandle,
    private readonly prompt: string,
    private readonly skillMessages: readonly UserMessage[],
  ) {
    this.publicationSeq = handle.agent.session.seq
  }

  get sessionId(): string {
    return this.handle.agent.id
  }

  async execute(): Promise<AutomationTerminalEvidence> {
    const { agent } = this.handle
    const firstSeq = agent.session.seq
    try {
      for (const message of this.skillMessages) agent.inject(message)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: this.prompt }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    } catch (error) {
      await this.flush(agent).catch(() => undefined)
      const evidence = summarizeAutomationEvents(agent.session.events, firstSeq)
      if (evidence.sessionEventSeq !== undefined) return evidence
      return { outcome: 'ambiguous', detail: errorDetail('Agent execution failed without terminal evidence', error) }
    }
    try {
      await this.flush(agent)
    } catch (error) {
      return {
        outcome: 'ambiguous',
        detail: errorDetail('The Agent finished but its Session durability checkpoint failed', error),
      }
    }
    return summarizeAutomationEvents(agent.session.events, firstSeq)
  }

  cancel(): void {
    this.handle.agent.cancel({ kind: 'disposed' })
  }

  dispose(): Promise<void> {
    return this.handle.dispose()
  }

  private flush(agent: Agent): Promise<boolean> {
    return this.ctx.sessions.flush(agent.session)
  }
}

export class HarnessAutomationExecutor implements AutomationSessionExecutor {
  constructor(
    private readonly ctx: Context,
    private readonly connections: McpConnectionSupervisor,
  ) {}

  async prepare(dispatch: AutomationDispatchClaim, signal: AbortSignal): Promise<AutomationExecutionHandle> {
    signal.throwIfAborted()
    const connectionScope = this.connections.automationScope(dispatch.run.payload.connectionIds)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    let skillMessages: UserMessage[] = []
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(dispatch.run.payload.sessionId),
      meta: { cwd: dispatch.workspacePath },
      agentOptions: { provider: selection.provider, model: selection.model },
      signal,
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        installConnectionScope(agentCtx, connectionScope)
        skillMessages = await selectedSkillMessages(
          agentCtx,
          dispatch.run.payload.skillIds,
          dispatch.workspacePath,
          signal,
        )
      },
    })
    try {
      await handle.agent.whenIdle()
      return new HarnessAutomationExecution(this.ctx, handle, dispatch.run.payload.prompt, skillMessages)
    } catch (error) {
      await handle.dispose().catch(() => undefined)
      throw error
    }
  }
}

export class AutomationRunCoordinator {
  private requested = false
  private draining?: Promise<void>
  private active?: AutomationExecutionHandle
  private prepareAbort?: AbortController
  private disposed = false

  constructor(
    private readonly hostInstanceId: string,
    private readonly client: AutomationDesktopClient,
    private readonly executor: AutomationSessionExecutor,
    private readonly onError: AutomationRunErrorHandler = () => undefined,
  ) {}

  wake(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.requested = true
    if (this.draining === undefined) {
      const drain = this.drain()
      this.draining = drain.finally(() => {
        this.draining = undefined
        if (this.requested && !this.disposed) void this.wake()
      })
    }
    return this.draining
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.draining
    this.disposed = true
    this.requested = false
    this.prepareAbort?.abort()
    this.active?.cancel()
    await this.draining
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false
      const claimAbort = new AbortController()
      this.prepareAbort = claimAbort
      let dispatch: AutomationDispatchClaim | undefined
      try {
        dispatch = await this.client.claimNext(this.hostInstanceId, claimAbort.signal)
      } catch (error) {
        if (!this.disposed) this.onError('Could not claim durable automation work.', error)
        return
      } finally {
        if (this.prepareAbort === claimAbort) this.prepareAbort = undefined
      }
      if (dispatch === undefined) continue
      await this.run(dispatch)
      if (!this.disposed) this.requested = true
    }
  }

  private async run(dispatch: AutomationDispatchClaim): Promise<void> {
    if (dispatch.run.cancellationRequested) {
      await this.reportTerminal(dispatch.run.id, {
        outcome: 'cancelled',
        detail: 'The automation was cancelled before its Agent Session started.',
      })
      return
    }

    const prepareAbort = new AbortController()
    this.prepareAbort = prepareAbort
    let execution: AutomationExecutionHandle | undefined
    let running = false
    try {
      execution = await this.executor.prepare(dispatch, prepareAbort.signal)
      this.active = execution
      if (execution.sessionId !== dispatch.run.payload.sessionId) {
        throw new Error('The official Agent Session was created with the wrong identity.')
      }
      if (dispatch.worktreeId !== undefined) {
        const binding = await this.client.bindSession(
          execution.sessionId,
          dispatch.workspacePath,
          prepareAbort.signal,
        )
        if (!binding.managed || binding.worktree?.id !== dispatch.worktreeId) {
          throw new Error('The automation Agent Session did not bind to its reviewed managed worktree.')
        }
      }
      try {
        await this.client.markRunning(
          this.hostInstanceId,
          dispatch.run.id,
          execution.publicationSeq,
        )
        running = true
      } catch (error) {
        const evidence: AutomationTerminalEvidence = isAmbiguousError(error)
          ? {
              outcome: 'ambiguous',
              sessionEventSeq: execution.publicationSeq,
              detail: 'The running-state acknowledgement was ambiguous; no automation prompt was submitted.',
            }
          : {
              outcome: 'cancelled',
              sessionEventSeq: execution.publicationSeq,
              detail: 'The automation was stopped before its prompt was submitted.',
            }
        await this.reportTerminal(dispatch.run.id, evidence)
        return
      }
      const evidence = await execution.execute()
      await this.reportTerminal(dispatch.run.id, evidence)
    } catch (error) {
      if (this.disposed && !running) return
      await this.reportTerminal(dispatch.run.id, {
        outcome: running || isAmbiguousError(error) ? 'ambiguous' : 'failed',
        detail: errorDetail(
          running ? 'Agent execution stopped without trustworthy terminal evidence' : 'Agent Session setup failed',
          error,
        ),
      })
    } finally {
      if (this.prepareAbort === prepareAbort) this.prepareAbort = undefined
      if (execution !== undefined) {
        if (this.active === execution) this.active = undefined
        await execution.dispose().catch(error => {
          this.onError('Could not dispose an automation Agent Session cleanly.', error)
        })
      }
    }
  }

  private async reportTerminal(runId: string, evidence: AutomationTerminalEvidence): Promise<void> {
    try {
      await this.client.finish(this.hostInstanceId, runId, evidence)
    } catch (error) {
      if (!isAmbiguousError(error)) {
        this.onError('Could not record the automation terminal result.', error)
        return
      }
      try {
        await this.client.finish(this.hostInstanceId, runId, evidence)
      } catch (retryError) {
        this.onError('The exact automation terminal report could not be acknowledged.', retryError)
      }
    }
  }
}
