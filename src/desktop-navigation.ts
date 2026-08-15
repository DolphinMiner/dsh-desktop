import {
  DesktopRendererCommand,
  parseRendererCommand,
} from '@dolphinminer/dsh-desktop-protocol'

const MAX_PENDING_COMMANDS = 32

function decodedSegment(pathname: string): string | undefined {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return undefined
  try {
    return decodeURIComponent(segments[0]!)
  } catch {
    return undefined
  }
}

export function parseDesktopDeepLink(value: string): DesktopRendererCommand | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-desktop:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.hash !== '') return undefined

  if (url.hostname === 'session' && url.search === '') {
    return parseRendererCommand({ type: 'session.open', sessionId: decodedSegment(url.pathname) })
  }
  if (url.hostname === 'workspace' && url.search === '') {
    return parseRendererCommand({ type: 'workspace.open', workspaceId: decodedSegment(url.pathname) })
  }
  if (url.hostname === 'settings' && url.search === '') {
    const isRoot = url.pathname === '/' || url.pathname === ''
    const sectionId = isRoot ? undefined : decodedSegment(url.pathname)
    if (!isRoot && sectionId !== 'connections') return undefined
    return parseRendererCommand({ type: 'settings.open', ...(sectionId === undefined ? {} : { sectionId }) })
  }
  return undefined
}

export class DesktopCommandQueue {
  private readonly pending: DesktopRendererCommand[] = []

  enqueue(command: DesktopRendererCommand): void {
    const encoded = JSON.stringify(command)
    if (this.pending.some(item => JSON.stringify(item) === encoded)) return
    this.pending.push(command)
    if (this.pending.length > MAX_PENDING_COMMANDS) this.pending.shift()
  }

  drain(deliver: (command: DesktopRendererCommand) => boolean): number {
    let delivered = 0
    while (this.pending.length > 0) {
      const command = this.pending[0]!
      if (!deliver(command)) break
      this.pending.shift()
      delivered += 1
    }
    return delivered
  }

  get size(): number {
    return this.pending.length
  }
}
