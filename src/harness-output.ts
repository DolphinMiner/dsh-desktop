const READY_PREFIX = 'dsh web:'

export function parseHarnessUrl(line: string): string | undefined {
  const marker = line.indexOf(READY_PREFIX)
  if (marker === -1) return undefined

  const candidate = line.slice(marker + READY_PREFIX.length).trim()
  try {
    const url = new URL(candidate)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.protocol !== 'http:' || !loopback || url.port === '') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export class LineBuffer {
  private pending = ''

  push(chunk: string): string[] {
    this.pending += chunk
    const lines = this.pending.split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    return lines
  }

  flush(): string | undefined {
    if (this.pending === '') return undefined
    const line = this.pending
    this.pending = ''
    return line
  }
}
