import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopRendererCommand } from '@dolphinminer/dsh-desktop-protocol'

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface DesktopCommandEnvironment {
  ctx: Pick<ClientContext, 'sessions' | 'workspaces' | 'layout'>
  pickProjectDirectory(): Promise<string | null>
  openSettings(sectionId?: string): void | Promise<void>
}

function waitForSnapshot<T>(
  source: SnapshotSource<T>,
  ready: (snapshot: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const current = source.getSnapshot()
  if (ready(current)) return Promise.resolve(current)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let unsubscribe = (): void => undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      unsubscribe()
      result()
    }
    const removeSubscription = source.subscribe(() => {
      const snapshot = source.getSnapshot()
      if (ready(snapshot)) finish(() => resolve(snapshot))
    })
    unsubscribe = removeSubscription
    if (settled) {
      removeSubscription()
      return
    }
    timeout = setTimeout(() => {
      finish(() => reject(new Error('Harness state did not become ready in time.')))
    }, timeoutMs)
  })
}

export async function runDesktopCommand(
  environment: DesktopCommandEnvironment,
  command: DesktopRendererCommand,
): Promise<void> {
  const { ctx } = environment
  if (command.type === 'project.open') {
    const path = await environment.pickProjectDirectory()
    if (path === null) return
    const workspace = await ctx.workspaces.create({ path })
    ctx.workspaces.startSession(workspace.workspaceId)
    return
  }
  if (command.type === 'session.new') {
    ctx.workspaces.startSession()
    return
  }
  if (command.type === 'session.open') {
    const sessions = await waitForSnapshot(ctx.sessions.list, snapshot => snapshot.phase === 'ready')
    const sessionId = command.sessionId as SessionId
    if (sessions.byId[sessionId] === undefined) throw new Error('The requested session no longer exists.')
    ctx.sessions.open(sessionId)
    return
  }
  if (command.type === 'workspace.open') {
    const workspaces = await waitForSnapshot(ctx.workspaces.list, snapshot => snapshot.phase === 'ready')
    const workspace = workspaces.items.find(item => item.workspaceId === command.workspaceId)
    if (workspace === undefined) throw new Error('The requested workspace no longer exists.')
    ctx.workspaces.startSession(workspace.workspaceId)
    return
  }
  if (command.type === 'worktree.open') {
    const workspace = await ctx.workspaces.create({ path: command.path })
    const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
    ctx.sessions.open(sessionId)
    return
  }
  if (command.type === 'session.stop') {
    const sessionId = command.sessionId as SessionId | undefined ?? ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return
    const result = await ctx.sessions.binding(sessionId)?.session.cancel()
    if (result !== undefined && !result.ok) throw new Error(result.error.message)
    return
  }
  if (command.type === 'settings.open') {
    await environment.openSettings(command.sectionId)
    return
  }
  ctx.layout.toggleSidebar()
}
