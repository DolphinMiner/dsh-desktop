import { DesktopSessionActivityParams } from '@dolphinminer/dsh-desktop-protocol'

export interface DesktopActivitySnapshot {
  runningSessionIds: readonly string[]
  workspacePaths: Readonly<Record<string, string>>
}

interface SessionActivity {
  eventSeq: number
  running: boolean
  workspacePath?: string
}

export class DesktopActivityTracker {
  private readonly sessions = new Map<string, SessionActivity>()

  constructor(private readonly onChange: (snapshot: DesktopActivitySnapshot) => void) {}

  report(params: DesktopSessionActivityParams): boolean {
    const previous = this.sessions.get(params.sessionId)
    if (previous !== undefined && params.eventSeq <= previous.eventSeq) return false
    this.sessions.set(params.sessionId, {
      eventSeq: params.eventSeq,
      running: params.running,
      ...(params.workspacePath === undefined ? {} : { workspacePath: params.workspacePath }),
    })
    this.publish()
    return true
  }

  clear(): void {
    if (this.sessions.size === 0) return
    this.sessions.clear()
    this.publish()
  }

  snapshot(): DesktopActivitySnapshot {
    const runningSessionIds: string[] = []
    const workspacePaths: Record<string, string> = {}
    for (const [sessionId, activity] of this.sessions) {
      if (!activity.running) continue
      runningSessionIds.push(sessionId)
      if (activity.workspacePath !== undefined) workspacePaths[sessionId] = activity.workspacePath
    }
    return { runningSessionIds, workspacePaths }
  }

  private publish(): void {
    this.onChange(this.snapshot())
  }
}
