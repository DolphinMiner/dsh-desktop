import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  ComputerApplicationList,
  ComputerControlSnapshot,
  ComputerObservation,
  ComputerPermissions,
  ComputerTarget,
  ComputerTargetList,
  DesktopProtocolError,
  parseComputerObservation,
} from '@dolphinminer/dsh-desktop-protocol'

export interface ComputerHelperObserveInput {
  snapshotId: string
  target: ComputerTarget
  screenshotPath: string
  maxDepth: number
  maxElements: number
}

export interface ComputerHelper {
  getPermissions(signal?: AbortSignal): Promise<ComputerPermissions>
  listTargets(signal?: AbortSignal): Promise<ComputerTargetList>
  observe(input: ComputerHelperObserveInput, signal?: AbortSignal): Promise<unknown>
  dispose(): Promise<void>
}

export interface ComputerObserverOptions {
  maxElements?: number
  maxDepth?: number
  onChange?: (snapshot: ComputerControlSnapshot) => void
}

export interface ComputerCaptureStoreOptions {
  maxFiles?: number
  maxAgeMs?: number
  maxFileBytes?: number
  now?: () => number
}

type ComputerErrorCode = Extract<DesktopProtocolError['code'],
  'BAD_MESSAGE' | 'CANCELLED' | 'CONFLICT' | 'DESKTOP_UNAVAILABLE' | 'NOT_FOUND' |
  'PERMISSION_DENIED' | 'TARGET_CHANGED' | 'UNSUPPORTED'>

const EMPTY_PERMISSIONS: ComputerPermissions = {
  supported: false,
  screenRecording: 'unavailable',
  accessibility: 'unavailable',
  canObserve: false,
}

export class ComputerUseError extends Error {
  constructor(readonly code: ComputerErrorCode, message: string) {
    super(message)
    this.name = 'ComputerUseError'
  }
}

function cloneTarget(target: ComputerTarget): ComputerTarget {
  return {
    ...target,
    ...(target.bounds === undefined ? {} : { bounds: { ...target.bounds } }),
  }
}

function clonePermissions(value: ComputerPermissions): ComputerPermissions {
  return { ...value }
}

export class ComputerCaptureStore {
  private readonly maxFiles: number
  private readonly maxAgeMs: number
  private readonly maxFileBytes: number
  private readonly now: () => number

  constructor(
    readonly root: string,
    options: ComputerCaptureStoreOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? 5
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000
    this.maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024
    this.now = options.now ?? Date.now
  }

  async allocate(snapshotId: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/i.test(snapshotId)) {
      throw new ComputerUseError('BAD_MESSAGE', 'The computer snapshot identifier is invalid.')
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await this.prune()
    return join(this.root, `${snapshotId}.png`)
  }

  async accept(path: string): Promise<void> {
    this.assertOwned(path)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > this.maxFileBytes) {
      await this.discard(path)
      throw new ComputerUseError('BAD_MESSAGE', 'The native helper returned an invalid screenshot.')
    }
    await chmod(path, 0o600)
    await this.prune()
  }

  async discard(path: string): Promise<void> {
    this.assertOwned(path)
    await unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  private assertOwned(path: string): void {
    if (join(this.root, basename(path)) !== path || !path.endsWith('.png')) {
      throw new ComputerUseError('BAD_MESSAGE', 'The screenshot path is outside the private capture directory.')
    }
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.root).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const files = await Promise.all(entries
      .filter(name => /^[a-f0-9-]{36}\.png$/i.test(name))
      .map(async name => {
        const path = join(this.root, name)
        const info = await stat(path)
        return { path, modifiedAt: info.mtimeMs }
      }))
    files.sort((left, right) => right.modifiedAt - left.modifiedAt)
    const expiredAt = this.now() - this.maxAgeMs
    await Promise.all(files.map((file, index) => {
      if (index < this.maxFiles && file.modifiedAt >= expiredAt) return Promise.resolve()
      return this.discard(file.path)
    }))
  }
}

export class ComputerObserver {
  private revision = 0
  private permissions: ComputerPermissions = EMPTY_PERMISSIONS
  private targets: ComputerTarget[] = []
  private selectedTarget?: ComputerTarget
  private lastObservation?: ComputerObservation
  private observing = false
  private activeController?: AbortController
  private statusMessage?: string
  private readonly maxElements: number
  private readonly maxDepth: number
  private readonly onChange?: (snapshot: ComputerControlSnapshot) => void

  constructor(
    private readonly helper: ComputerHelper,
    private readonly captures: ComputerCaptureStore,
    options: ComputerObserverOptions = {},
  ) {
    this.maxElements = options.maxElements ?? 400
    this.maxDepth = options.maxDepth ?? 12
    this.onChange = options.onChange
  }

  snapshot(): ComputerControlSnapshot {
    return {
      revision: this.revision,
      enabled: this.selectedTarget !== undefined,
      observing: this.observing,
      permissions: clonePermissions(this.permissions),
      targets: this.targets.map(cloneTarget),
      ...(this.selectedTarget === undefined ? {} : { selectedTarget: cloneTarget(this.selectedTarget) }),
      ...(this.lastObservation === undefined ? {} : {
        lastObservation: {
          snapshotId: this.lastObservation.snapshotId,
          observedAt: this.lastObservation.observedAt,
          target: cloneTarget(this.lastObservation.target),
          elementCount: this.lastObservation.elements.length,
          screenshotCaptured: this.lastObservation.capture.screenshotCaptured,
        },
      }),
      ...(this.statusMessage === undefined ? {} : { statusMessage: this.statusMessage }),
    }
  }

  async refresh(signal?: AbortSignal): Promise<ComputerControlSnapshot> {
    this.assertNotAborted(signal)
    try {
      const result = await this.helper.listTargets(signal)
      this.permissions = clonePermissions(result.permissions)
      this.targets = result.targets.map(cloneTarget)
      if (this.selectedTarget !== undefined) {
        const current = this.targets.find(target => target.id === this.selectedTarget?.id)
        if (current === undefined) {
          this.selectedTarget = undefined
          this.lastObservation = undefined
          this.statusMessage = 'The selected application or window is no longer available.'
        } else {
          this.selectedTarget = cloneTarget(current)
        }
      }
      this.bump()
      return this.snapshot()
    } catch (error) {
      this.statusMessage = error instanceof Error ? error.message : 'Computer targets are unavailable.'
      this.bump()
      throw this.wrapHelperError(error)
    }
  }

  async getPermissions(signal?: AbortSignal): Promise<ComputerPermissions> {
    this.assertNotAborted(signal)
    try {
      this.permissions = clonePermissions(await this.helper.getPermissions(signal))
      this.statusMessage = undefined
      this.bump()
      return clonePermissions(this.permissions)
    } catch (error) {
      throw this.wrapHelperError(error)
    }
  }

  async listApplications(signal?: AbortSignal): Promise<ComputerApplicationList> {
    await this.refresh(signal)
    return {
      permissions: clonePermissions(this.permissions),
      applications: this.targets
        .filter((target): target is ComputerTarget & { pid: number } =>
          target.kind === 'application' && target.pid !== undefined)
        .map(target => ({
          id: target.id,
          name: target.name,
          ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
          pid: target.pid,
          frontmost: target.frontmost ?? false,
        })),
      ...(this.selectedTarget === undefined ? {} : { selectedTarget: cloneTarget(this.selectedTarget) }),
    }
  }

  async selectTarget(targetId: string, signal?: AbortSignal): Promise<ComputerControlSnapshot> {
    if (targetId.length === 0 || targetId.length > 256) {
      throw new ComputerUseError('BAD_MESSAGE', 'The computer target identifier is invalid.')
    }
    await this.refresh(signal)
    const target = this.targets.find(item => item.id === targetId)
    if (target === undefined) throw new ComputerUseError('NOT_FOUND', 'The selected computer target is unavailable.')
    this.activeController?.abort()
    this.selectedTarget = cloneTarget(target)
    this.lastObservation = undefined
    this.statusMessage = undefined
    await this.captures.cleanup()
    this.bump()
    return this.snapshot()
  }

  async observe(sessionId: string, signal?: AbortSignal): Promise<ComputerObservation> {
    if (sessionId.length === 0) throw new ComputerUseError('BAD_MESSAGE', 'An agent session is required.')
    if (this.observing) throw new ComputerUseError('CONFLICT', 'A computer observation is already running.')
    await this.refresh(signal)
    if (!this.permissions.supported) {
      throw new ComputerUseError('UNSUPPORTED', 'Computer observation is only available on supported macOS builds.')
    }
    if (this.permissions.screenRecording !== 'granted') {
      throw new ComputerUseError(
        'PERMISSION_DENIED',
        'Screen Recording permission is required. Enable it in System Settings > Privacy & Security.',
      )
    }
    const target = this.selectedTarget
    if (target === undefined) {
      throw new ComputerUseError('NOT_FOUND', 'Select an application, window, or display in Desktop settings first.')
    }

    const snapshotId = randomUUID()
    const screenshotPath = await this.captures.allocate(snapshotId)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.activeController = controller
    this.observing = true
    this.statusMessage = undefined
    this.bump()

    try {
      const raw = await this.helper.observe({
        snapshotId,
        target: cloneTarget(target),
        screenshotPath,
        maxDepth: this.maxDepth,
        maxElements: this.maxElements,
      }, controller.signal)
      this.assertNotAborted(controller.signal)
      const observation = parseComputerObservation(raw)
      if (observation === undefined || observation.snapshotId !== snapshotId) {
        throw new ComputerUseError('BAD_MESSAGE', 'The native helper returned an invalid observation.')
      }
      if (observation.target.id !== target.id || observation.target.kind !== target.kind) {
        throw new ComputerUseError('TARGET_CHANGED', 'The selected computer target changed during observation.')
      }
      if (observation.capture.screenshotCaptured) await this.captures.accept(screenshotPath)
      else await this.captures.discard(screenshotPath)
      this.lastObservation = observation
      return observation
    } catch (error) {
      await this.captures.discard(screenshotPath).catch(() => undefined)
      this.statusMessage = error instanceof Error ? error.message : 'Computer observation failed.'
      throw this.wrapHelperError(error)
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.activeController === controller) this.activeController = undefined
      this.observing = false
      this.bump()
    }
  }

  async stop(): Promise<ComputerControlSnapshot> {
    this.activeController?.abort()
    this.activeController = undefined
    this.selectedTarget = undefined
    this.lastObservation = undefined
    this.observing = false
    this.statusMessage = undefined
    await this.captures.cleanup()
    this.bump()
    return this.snapshot()
  }

  async dispose(): Promise<void> {
    await this.stop()
    await this.helper.dispose()
  }

  private bump(): void {
    this.revision += 1
    this.onChange?.(this.snapshot())
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted !== true) return
    throw new DOMException('The computer operation was cancelled.', 'AbortError')
  }

  private wrapHelperError(error: unknown): Error {
    if (error instanceof ComputerUseError || (error instanceof Error && error.name === 'AbortError')) return error
    return new ComputerUseError(
      'DESKTOP_UNAVAILABLE',
      error instanceof Error ? error.message : 'The native computer helper is unavailable.',
    )
  }
}
