import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  DesktopSessionActivityParams,
  GitTurnBoundaryParams,
  GitTurnStartBoundaryParams,
} from '@dolphinminer/dsh-desktop-protocol'

interface TurnSession {
  id: string
  header: { cwd?: string }
  events: readonly SessionEvent[]
}

interface StartOperation {
  turn: number
  eventSeq: number
  operation: Promise<void>
}

export type GitTurnBoundaryReporter = (params: GitTurnBoundaryParams) => Promise<void>
export type SessionActivityReporter = (params: DesktopSessionActivityParams) => Promise<void>

export async function reportTurnBoundaryAndActivity(
  params: GitTurnBoundaryParams,
  reportActivity: SessionActivityReporter,
  reportBoundary: GitTurnBoundaryReporter,
): Promise<void> {
  let activityFailure: { error: unknown } | undefined
  try {
    await reportActivity({
      sessionId: params.sessionId,
      eventSeq: params.eventSeq,
      running: params.boundary === 'start',
      workspacePath: params.workspaceRoot,
    })
  } catch (error) {
    activityFailure = { error }
  }

  await reportBoundary(params)
  if (activityFailure !== undefined) throw activityFailure.error
}

function currentStart(session: TurnSession): GitTurnStartBoundaryParams | undefined {
  if (session.header.cwd === undefined) return undefined
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type === 'turn/end') return undefined
    if (event.type !== 'turn/start') continue
    return {
      sessionId: session.id,
      workspaceRoot: session.header.cwd,
      turn: event.data.turn,
      eventSeq: event.seq,
      eventTime: event.time,
      boundary: 'start',
    }
  }
  return undefined
}

export class GitTurnBoundaryCoordinator {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly starts = new Map<string, StartOperation>()

  constructor(
    private readonly report: GitTurnBoundaryReporter,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  observe(params: GitTurnBoundaryParams): Promise<void> {
    if (params.boundary === 'start') {
      const current = this.starts.get(params.sessionId)
      if (current?.turn === params.turn && current.eventSeq === params.eventSeq) return current.operation
    }
    const previous = this.queues.get(params.sessionId) ?? Promise.resolve()
    const operation = previous
      .then(() => this.report(params))
      .catch(error => { this.onError(error) })
    this.queues.set(params.sessionId, operation)
    if (params.boundary === 'start') {
      this.starts.set(params.sessionId, { turn: params.turn, eventSeq: params.eventSeq, operation })
    } else {
      void operation.finally(() => {
        const start = this.starts.get(params.sessionId)
        if (start?.turn === params.turn) this.starts.delete(params.sessionId)
      })
    }
    void operation.finally(() => {
      if (this.queues.get(params.sessionId) === operation) this.queues.delete(params.sessionId)
    })
    return operation
  }

  async beforeTool(agent?: { id: string; session: TurnSession }): Promise<void> {
    if (agent === undefined) return
    const tracked = this.starts.get(agent.id)
    if (tracked !== undefined) {
      await tracked.operation
      return
    }
    const start = currentStart(agent.session)
    if (start === undefined) return
    await this.observe(start)
  }
}
