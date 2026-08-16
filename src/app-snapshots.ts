import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  AppSnapshotCapture,
  AppSnapshotDestination,
  AppSnapshotSettings,
  AppSnapshotState,
  ComputerObservation,
  ComputerPermissions,
  UpdateAppSnapshotSettingsInput,
  parseComputerObservation,
  parseAppSnapshotSettings,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'
import {
  ComputerCaptureStore,
  ComputerHelper,
  ComputerUseError,
} from './computer-observer'

const APP_SNAPSHOT_SETTINGS_SCHEMA_VERSION = 1
const MAX_DELIVERY_BYTES = 5 * 1024 * 1024
const MAX_OCR_LENGTH = 12_000

export const DEFAULT_APP_SNAPSHOT_SETTINGS: AppSnapshotSettings = {
  shortcut: 'CommandOrControl+Shift+2',
  destination: { kind: 'automatic' },
  captureSound: true,
}

const EMPTY_PERMISSIONS: ComputerPermissions = {
  supported: false,
  screenRecording: 'unavailable',
  accessibility: 'unavailable',
  canObserve: false,
  canAct: false,
}

interface AppSnapshotSettingsDocument {
  schemaVersion: typeof APP_SNAPSHOT_SETTINGS_SCHEMA_VERSION
  settings: AppSnapshotSettings
}

export interface AppSnapshotShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface AppSnapshotImage {
  data: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  pixelWidth: number
  pixelHeight: number
}

export interface AppSnapshotControllerOptions {
  now?: () => Date
  onChange?: (state: AppSnapshotState) => void
  processImage?: (data: Uint8Array, observation: ComputerObservation) => AppSnapshotImage
  playCaptureSound?: () => void
}

function cloneDestination(destination: AppSnapshotDestination): AppSnapshotDestination {
  return destination.kind === 'automatic'
    ? { kind: 'automatic' }
    : { kind: 'session', sessionId: destination.sessionId }
}

function cloneSettings(settings: AppSnapshotSettings): AppSnapshotSettings {
  return { ...settings, destination: cloneDestination(settings.destination) }
}

function clonePermissions(permissions: ComputerPermissions): ComputerPermissions {
  return { ...permissions }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.slice(0, 1_000)
  return 'The app snapshot could not be captured.'
}

function normalizedOcr(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll('\u0000', '').trim()
  if (normalized === undefined || normalized === '') return undefined
  return normalized.slice(0, MAX_OCR_LENGTH)
}

export class AppSnapshotSettingsStore {
  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  load(): { settings: AppSnapshotSettings; recovered: boolean } {
    try {
      const value = readJsonFile(this.path)
      if (value === undefined) return { settings: cloneSettings(DEFAULT_APP_SNAPSHOT_SETTINGS), recovered: false }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('The App Snapshot settings file has an invalid shape.')
      }
      const document = value as Partial<AppSnapshotSettingsDocument>
      const settings = parseAppSnapshotSettings(document.settings)
      if (document.schemaVersion !== APP_SNAPSHOT_SETTINGS_SCHEMA_VERSION || settings === undefined) {
        throw new Error('The App Snapshot settings file uses an unsupported schema.')
      }
      return { settings, recovered: false }
    } catch (error) {
      this.onError(error)
      return { settings: cloneSettings(DEFAULT_APP_SNAPSHOT_SETTINGS), recovered: true }
    }
  }

  save(settings: AppSnapshotSettings): void {
    writeJsonAtomically(this.path, {
      schemaVersion: APP_SNAPSHOT_SETTINGS_SCHEMA_VERSION,
      settings: cloneSettings(settings),
    } satisfies AppSnapshotSettingsDocument)
  }
}

export class AppSnapshotController {
  private revision = 0
  private settings = cloneSettings(DEFAULT_APP_SNAPSHOT_SETTINGS)
  private permissions = clonePermissions(EMPTY_PERMISSIONS)
  private shortcutRegistered = false
  private capturing = false
  private lastCapture?: AppSnapshotState['lastCapture']
  private statusMessage?: string
  private shortcutHandler?: () => void
  private captureController?: AbortController
  private disposed = false
  private readonly now: () => Date
  private readonly onChange: (state: AppSnapshotState) => void
  private readonly processImage: NonNullable<AppSnapshotControllerOptions['processImage']>
  private readonly playCaptureSound: () => void

  constructor(
    private readonly store: AppSnapshotSettingsStore,
    private readonly helper: ComputerHelper,
    private readonly captures: ComputerCaptureStore,
    private readonly shortcuts: AppSnapshotShortcutRegistrar,
    options: AppSnapshotControllerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.onChange = options.onChange ?? (() => undefined)
    this.processImage = options.processImage ?? ((data, observation) => ({
      data,
      mediaType: 'image/png',
      pixelWidth: observation.capture.pixelWidth,
      pixelHeight: observation.capture.pixelHeight,
    }))
    this.playCaptureSound = options.playCaptureSound ?? (() => undefined)
  }

  snapshot(): AppSnapshotState {
    return {
      revision: this.revision,
      settings: cloneSettings(this.settings),
      shortcutRegistered: this.shortcutRegistered,
      capturing: this.capturing,
      permissions: clonePermissions(this.permissions),
      ...(this.lastCapture === undefined ? {} : { lastCapture: { ...this.lastCapture } }),
      ...(this.statusMessage === undefined ? {} : { statusMessage: this.statusMessage }),
    }
  }

  async start(onShortcut: () => void): Promise<AppSnapshotState> {
    if (this.disposed) throw new Error('App Snapshots have stopped.')
    this.shortcutHandler = onShortcut
    const loaded = this.store.load()
    this.settings = cloneSettings(loaded.settings)
    this.shortcutRegistered = this.registerShortcut(this.settings.shortcut)
    this.statusMessage = loaded.recovered
      ? 'App Snapshot settings were reset because the saved file could not be read.'
      : this.shortcutRegistered
        ? undefined
        : 'The App Snapshot shortcut is already used by another application.'
    await this.refreshPermissions(false)
    this.bump()
    return this.snapshot()
  }

  async refresh(): Promise<AppSnapshotState> {
    await this.refreshPermissions(true)
    return this.snapshot()
  }

  update(input: UpdateAppSnapshotSettingsInput): AppSnapshotState {
    if (this.disposed) throw new Error('App Snapshots have stopped.')
    const next: AppSnapshotSettings = {
      shortcut: input.shortcut ?? this.settings.shortcut,
      destination: cloneDestination(input.destination ?? this.settings.destination),
      captureSound: input.captureSound ?? this.settings.captureSound,
    }
    this.store.save(next)
    if (next.shortcut !== this.settings.shortcut) {
      this.shortcuts.unregister(this.settings.shortcut)
      this.shortcutRegistered = this.registerShortcut(next.shortcut)
    }
    this.settings = next
    this.statusMessage = this.shortcutRegistered
      ? undefined
      : 'The App Snapshot shortcut is already used by another application.'
    this.bump()
    return this.snapshot()
  }

  async capture(): Promise<AppSnapshotCapture> {
    if (this.disposed) throw new Error('App Snapshots have stopped.')
    if (this.capturing) throw new ComputerUseError('CONFLICT', 'An app snapshot is already being captured.')
    const controller = new AbortController()
    const destination = cloneDestination(this.settings.destination)
    this.captureController = controller
    this.capturing = true
    this.statusMessage = undefined
    this.bump()

    try {
      const targets = await this.helper.listTargets(controller.signal)
      this.permissions = clonePermissions(targets.permissions)
      if (!targets.permissions.canObserve) {
        throw new ComputerUseError(
          'PERMISSION_DENIED',
          'Screen Recording permission is required to capture an app snapshot.',
        )
      }
      const target = targets.targets.find(candidate =>
        candidate.kind === 'application' && candidate.frontmost === true)
      if (target === undefined) {
        throw new ComputerUseError('NOT_FOUND', 'No frontmost application window is available to capture.')
      }

      const id = randomUUID()
      const path = await this.captures.allocate(id)
      let observation: ComputerObservation
      let raw: Uint8Array
      try {
        const observed = await this.helper.observe({
          snapshotId: id,
          target,
          screenshotPath: path,
          maxDepth: 12,
          maxElements: 400,
        }, controller.signal)
        const parsedObservation = parseComputerObservation(observed)
        if (parsedObservation === undefined) {
          throw new ComputerUseError('BAD_MESSAGE', 'The native helper returned an invalid app snapshot.')
        }
        observation = parsedObservation
        if (observation.snapshotId !== id || observation.target.id !== target.id ||
          observation.capture.screenshotCaptured !== true) {
          throw new ComputerUseError('TARGET_CHANGED', 'The frontmost application changed during capture.')
        }
        await this.captures.accept(path)
        raw = new Uint8Array(await readFile(path))
      } finally {
        await this.captures.discard(path).catch(() => undefined)
      }

      const image = this.processImage(raw, observation)
      if (!(image.data instanceof Uint8Array) || image.data.byteLength === 0 ||
        image.data.byteLength > MAX_DELIVERY_BYTES || !Number.isSafeInteger(image.pixelWidth) ||
        !Number.isSafeInteger(image.pixelHeight) || image.pixelWidth <= 0 || image.pixelHeight <= 0) {
        throw new ComputerUseError('BAD_MESSAGE', 'The captured image could not be prepared for the conversation.')
      }
      const capturedAt = this.now().toISOString()
      this.lastCapture = {
        id,
        capturedAt,
        sourceName: target.name,
        ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
        pixelWidth: image.pixelWidth,
        pixelHeight: image.pixelHeight,
      }
      if (this.settings.captureSound) {
        try {
          this.playCaptureSound()
        } catch {
          // Sound is feedback only; a completed capture remains valid.
        }
      }
      const ocrText = normalizedOcr(observation.capture.ocrText)
      return {
        ...this.lastCapture,
        destination,
        mediaType: image.mediaType,
        fileName: image.mediaType === 'image/jpeg' ? 'app-snapshot.jpg' : 'app-snapshot.png',
        data: image.data.slice(),
        ...(ocrText === undefined ? {} : { ocrText }),
      }
    } catch (error) {
      this.statusMessage = failureMessage(error)
      throw error
    } finally {
      if (this.captureController === controller) this.captureController = undefined
      this.capturing = false
      this.bump()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.captureController?.abort()
    this.shortcuts.unregister(this.settings.shortcut)
    this.shortcutRegistered = false
    await this.captures.cleanup()
  }

  private registerShortcut(accelerator: string): boolean {
    if (this.shortcutHandler === undefined) return false
    try {
      return this.shortcuts.register(accelerator, this.shortcutHandler)
    } catch {
      return false
    }
  }

  private async refreshPermissions(publish: boolean): Promise<void> {
    try {
      this.permissions = clonePermissions(await this.helper.getPermissions())
      if (publish) {
        this.statusMessage = this.shortcutRegistered
          ? undefined
          : 'The App Snapshot shortcut is already used by another application.'
      }
    } catch (error) {
      this.permissions = clonePermissions(EMPTY_PERMISSIONS)
      this.statusMessage = failureMessage(error)
    }
    if (publish) this.bump()
  }

  private bump(): void {
    this.revision += 1
    this.onChange(this.snapshot())
  }
}
