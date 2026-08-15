import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PersistedWindowState {
  version: 1
  bounds: WindowBounds
  maximized: boolean
}

export interface WindowStateStoreOptions {
  saveDelayMs?: number
  onError?: (error: unknown) => void
}

const MIN_VISIBLE_EDGE = 80
const MIN_WINDOW_WIDTH = 1_024
const MIN_WINDOW_HEIGHT = 700
const DEFAULT_SAVE_DELAY_MS = 300

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function parseWindowState(value: unknown): PersistedWindowState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<PersistedWindowState>
  const bounds = candidate.bounds
  if (candidate.version !== 1 || typeof candidate.maximized !== 'boolean' ||
    typeof bounds !== 'object' || bounds === null ||
    !isFiniteInteger(bounds.x) || !isFiniteInteger(bounds.y) ||
    !isFiniteInteger(bounds.width) || !isFiniteInteger(bounds.height) ||
    bounds.width < MIN_WINDOW_WIDTH || bounds.height < MIN_WINDOW_HEIGHT) return undefined
  return {
    version: 1,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    maximized: candidate.maximized,
  }
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

export function restoreWindowState(
  value: unknown,
  workAreas: readonly WindowBounds[],
): PersistedWindowState | undefined {
  const state = parseWindowState(value)
  if (state === undefined || workAreas.length === 0) return undefined

  let target: WindowBounds | undefined
  let bestArea = 0
  for (const workArea of workAreas) {
    const area = intersectionArea(state.bounds, workArea)
    if (area <= bestArea) continue
    bestArea = area
    target = workArea
  }
  if (target === undefined) return undefined

  const visibleWidth = Math.max(
    0,
    Math.min(state.bounds.x + state.bounds.width, target.x + target.width) - Math.max(state.bounds.x, target.x),
  )
  const visibleHeight = Math.max(
    0,
    Math.min(state.bounds.y + state.bounds.height, target.y + target.height) - Math.max(state.bounds.y, target.y),
  )
  if (visibleWidth < MIN_VISIBLE_EDGE || visibleHeight < MIN_VISIBLE_EDGE) return undefined

  const width = Math.min(state.bounds.width, target.width)
  const height = Math.min(state.bounds.height, target.height)
  const x = Math.min(Math.max(state.bounds.x, target.x), target.x + target.width - width)
  const y = Math.min(Math.max(state.bounds.y, target.y), target.y + target.height - height)
  return { version: 1, bounds: { x, y, width, height }, maximized: state.maximized }
}

export class WindowStateStore {
  private readonly saveDelayMs: number
  private readonly onError: (error: unknown) => void
  private pending?: PersistedWindowState
  private timer?: NodeJS.Timeout
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string, options: WindowStateStoreOptions = {}) {
    this.saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS
    this.onError = options.onError ?? (() => undefined)
  }

  async load(workAreas: readonly WindowBounds[]): Promise<PersistedWindowState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      return restoreWindowState(value, workAreas)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        this.onError(error)
      }
      return undefined
    }
  }

  schedule(state: PersistedWindowState): void {
    this.pending = state
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.writePending().catch(this.onError)
    }, this.saveDelayMs)
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.pending !== undefined) await this.writePending()
    await this.writeQueue
  }

  private writePending(): Promise<void> {
    const state = this.pending
    this.pending = undefined
    if (state === undefined) return this.writeQueue

    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporaryPath = `${this.path}.${String(process.pid)}.tmp`
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
        await rename(temporaryPath, this.path)
      } finally {
        await rm(temporaryPath, { force: true })
      }
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }
}
