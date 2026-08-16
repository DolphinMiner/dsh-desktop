import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  COMPUTER_ACTION_VERSION,
  ComputerActParams,
  ComputerAction,
  ComputerActionHistorySummary,
  ComputerActionResult,
  ComputerApplicationAccess,
  ComputerApplicationList,
  ComputerControlPolicy,
  ComputerControlSnapshot,
  ComputerElement,
  ComputerObservation,
  ComputerPermissions,
  ComputerSnapshotCompatibility,
  ComputerTarget,
  ComputerTargetList,
  DesktopProtocolError,
  UpdateComputerControlPolicyInput,
  parseComputerActParams,
  parseComputerObservation,
  summarizeComputerAction,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  ComputerActionAuditError,
  ComputerActionAuditStore,
} from './computer-action-audit'
import {
  ComputerControlPolicyStore,
  DEFAULT_COMPUTER_CONTROL_POLICY,
  cloneComputerControlPolicy,
} from './computer-policy'

export interface ComputerHelperObserveInput {
  snapshotId: string
  target: ComputerTarget
  screenshotPath: string
  maxDepth: number
  maxElements: number
}

export interface ComputerHelperActInput {
  actionId: string
  target: ComputerTarget
  sourceSnapshotId: string
  compatibility: ComputerSnapshotCompatibility
  maxDepth: number
  maxElements: number
  action: ComputerAction
  element?: ComputerElement
}

export interface ComputerHelperActResult {
  actionId: string
  performedAt: string
}

export interface ComputerHelper {
  getPermissions(signal?: AbortSignal): Promise<ComputerPermissions>
  listTargets(signal?: AbortSignal): Promise<ComputerTargetList>
  observe(input: ComputerHelperObserveInput, signal?: AbortSignal): Promise<unknown>
  act(input: ComputerHelperActInput, signal?: AbortSignal): Promise<ComputerHelperActResult>
  dispose(): Promise<void>
}

export interface ComputerObserverOptions {
  maxElements?: number
  maxDepth?: number
  audit?: ComputerActionAuditStore
  policyStore?: ComputerControlPolicyStore
  now?: () => Date
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
  'PERMISSION_DENIED' | 'TARGET_CHANGED' | 'UNSUPPORTED' | 'DUPLICATE_REQUEST'>

const EMPTY_PERMISSIONS: ComputerPermissions = {
  supported: false,
  screenRecording: 'unavailable',
  accessibility: 'unavailable',
  canObserve: false,
  canAct: false,
}

export class ComputerUseError extends Error {
  constructor(readonly code: ComputerErrorCode, message: string, readonly ambiguous = false) {
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

function redactTypedObservation(observation: ComputerObservation): ComputerObservation {
  const { ocrText: _ocrText, ...capture } = observation.capture
  return {
    ...observation,
    capture,
    elements: observation.elements.map(element => {
      const { value: _value, ...redacted } = element
      return redacted
    }),
  }
}

interface PreparedComputerAction {
  params: ComputerActParams
  target: ComputerTarget
  observation: ComputerObservation
  element?: ComputerElement
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
  private lastObservationSessionId?: string
  private observing = false
  private acting = false
  private actionsPaused = false
  private activeController?: AbortController
  private activeActionController?: AbortController
  private policy = cloneComputerControlPolicy(DEFAULT_COMPUTER_CONTROL_POLICY)
  private readonly policyStore?: ComputerControlPolicyStore
  private statusMessage?: string
  private readonly maxElements: number
  private readonly maxDepth: number
  private readonly audit?: ComputerActionAuditStore
  private readonly now: () => Date
  private readonly onChange?: (snapshot: ComputerControlSnapshot) => void

  constructor(
    private readonly helper: ComputerHelper,
    private readonly captures: ComputerCaptureStore,
    options: ComputerObserverOptions = {},
  ) {
    this.maxElements = options.maxElements ?? 400
    this.maxDepth = options.maxDepth ?? 12
    this.audit = options.audit
    this.policyStore = options.policyStore
    this.now = options.now ?? (() => new Date())
    this.onChange = options.onChange
    const loaded = this.policyStore?.load()
    if (loaded !== undefined) {
      this.policy = cloneComputerControlPolicy(loaded.policy)
      if (loaded.recovered) {
        this.statusMessage = 'Computer Control policy was reset because the saved file could not be read.'
      }
    }
  }

  snapshot(): ComputerControlSnapshot {
    const auditStatus = this.audit?.status()
    const recentActions: ComputerActionHistorySummary[] = (this.audit?.recent() ?? []).flatMap(record => {
      const latest = record.events.at(-1)
      if (latest === undefined) return []
      return [{
        actionId: record.actionId,
        sessionId: record.sessionId,
        sourceSnapshotId: record.sourceSnapshotId,
        targetName: record.target.name,
        kind: record.action.kind,
        status: latest.phase,
        updatedAt: latest.at,
        ...(latest.resultSnapshotId === undefined ? {} : { resultSnapshotId: latest.resultSnapshotId }),
      }]
    })
    return {
      revision: this.revision,
      enabled: this.policy.allowAnyApplication ||
        this.policy.applicationRules.some(rule => rule.access === 'allow'),
      observing: this.observing,
      acting: this.acting,
      actionsPaused: this.actionsPaused,
      auditAvailable: auditStatus?.available ?? false,
      permissions: clonePermissions(this.permissions),
      policy: cloneComputerControlPolicy(this.policy),
      applications: this.applicationAccess(),
      ...(this.selectedTarget === undefined ? {} : { activeTarget: cloneTarget(this.selectedTarget) }),
      ...(this.lastObservation === undefined ? {} : {
        lastObservation: {
          snapshotId: this.lastObservation.snapshotId,
          observedAt: this.lastObservation.observedAt,
          target: cloneTarget(this.lastObservation.target),
          elementCount: this.lastObservation.elements.length,
          screenshotCaptured: this.lastObservation.capture.screenshotCaptured,
        },
      }),
      recentActions,
      ...(this.statusMessage === undefined ? {} : { statusMessage: this.statusMessage }),
    }
  }

  async refresh(signal?: AbortSignal): Promise<ComputerControlSnapshot> {
    this.assertNotAborted(signal)
    try {
      const result = await this.helper.listTargets(signal)
      this.permissions = clonePermissions(result.permissions)
      this.targets = result.targets.map(cloneTarget)
      if (!this.permissions.canObserve) this.clearTransientObservation()
      else if (!this.permissions.canAct) this.activeActionController?.abort()
      if (this.selectedTarget !== undefined) {
        const current = this.targets.find(target => target.id === this.selectedTarget?.id)
        if (current === undefined) {
          this.selectedTarget = undefined
          this.lastObservation = undefined
          this.lastObservationSessionId = undefined
          this.statusMessage = 'The active application is no longer available.'
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
      if (!this.permissions.canObserve) this.clearTransientObservation()
      else if (!this.permissions.canAct) this.activeActionController?.abort()
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
      policy: cloneComputerControlPolicy(this.policy),
      applications: this.applicationAccess(),
      ...(this.selectedTarget === undefined ? {} : { activeTarget: cloneTarget(this.selectedTarget) }),
    }
  }

  updatePolicy(input: UpdateComputerControlPolicyInput): ComputerControlSnapshot {
    const next = cloneComputerControlPolicy(this.policy)
    if (input.allowAnyApplication !== undefined) {
      next.allowAnyApplication = input.allowAnyApplication
      next.applicationRules = next.applicationRules.filter(rule =>
        (rule.access === 'allow') !== next.allowAnyApplication)
    }
    if (input.lockScreenOperations !== undefined) {
      next.lockScreenOperations = input.lockScreenOperations
    }
    if (input.application !== undefined) {
      const existing = next.applicationRules.findIndex(rule => rule.bundleId === input.application?.bundleId)
      if (existing >= 0) next.applicationRules.splice(existing, 1)
      if (input.application.allowed !== next.allowAnyApplication) {
        next.applicationRules.push({
          bundleId: input.application.bundleId,
          name: input.application.name,
          access: input.application.allowed ? 'allow' : 'deny',
        })
      }
    }
    next.applicationRules.sort((left, right) => left.name.localeCompare(right.name))
    this.policyStore?.save(next)
    this.policy = next
    if (this.selectedTarget !== undefined && !this.targetAllowed(this.selectedTarget)) {
      this.activeController?.abort()
      this.activeActionController?.abort()
      this.clearTransientObservation()
    }
    this.statusMessage = undefined
    this.bump()
    return this.snapshot()
  }

  async observe(sessionId: string, application?: string, signal?: AbortSignal): Promise<ComputerObservation> {
    if (this.acting) throw new ComputerUseError('CONFLICT', 'A computer action is already running.')
    return this.captureObservation(sessionId, application, signal)
  }

  private async captureObservation(
    sessionId: string,
    application?: string,
    signal?: AbortSignal,
  ): Promise<ComputerObservation> {
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
    const target = this.resolveAllowedTarget(application)
    this.selectedTarget = cloneTarget(target)
    this.lastObservation = undefined
    this.lastObservationSessionId = undefined

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
      this.lastObservationSessionId = sessionId
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

  async act(value: ComputerActParams, signal?: AbortSignal): Promise<ComputerActionResult> {
    if (this.acting) throw new ComputerUseError('CONFLICT', 'A computer action is already running.')
    this.assertNotAborted(signal)
    const params = parseComputerActParams(value)
    if (params === undefined) throw new ComputerUseError('BAD_MESSAGE', 'The computer action request is invalid.')
    const audit = this.audit
    if (audit === undefined || !audit.status().available) {
      throw new ComputerUseError(
        'DESKTOP_UNAVAILABLE',
        audit?.status().message ?? 'The computer action audit log is unavailable.',
      )
    }
    if (audit.has(params.actionId)) {
      throw new ComputerUseError(
        'DUPLICATE_REQUEST',
        'This computer action identifier has already been used and will not be replayed.',
      )
    }
    const prepared = this.prepareAction(params)

    try {
      audit.recordIntent({
        actionId: prepared.params.actionId,
        sessionId: prepared.params.sessionId,
        sourceSnapshotId: prepared.params.snapshotId,
        target: prepared.target,
        action: prepared.params.action,
      })
      audit.recordApproval(prepared.params.actionId)
    } catch (error) {
      try {
        if (audit.get(prepared.params.actionId)?.events.at(-1)?.phase === 'intent') {
          audit.recordOutcome(prepared.params.actionId, 'cancelled', 'cancelled-before-dispatch')
        }
      } catch {
        // The persisted intent will be cancelled during cold-start recovery.
      }
      throw this.wrapActionError(error, false)
    }

    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.activeActionController = controller
    this.acting = true
    this.statusMessage = undefined
    this.bump()
    let dispatched = false
    let helperAcknowledged = false

    try {
      audit.recordDispatch(prepared.params.actionId)
      dispatched = true
      this.lastObservation = undefined
      this.lastObservationSessionId = undefined
      const receipt = await this.helper.act({
        actionId: prepared.params.actionId,
        target: cloneTarget(prepared.target),
        sourceSnapshotId: prepared.params.snapshotId,
        compatibility: prepared.observation.compatibility,
        maxDepth: this.maxDepth,
        maxElements: this.maxElements,
        action: prepared.params.action,
        ...(prepared.element === undefined ? {} : { element: prepared.element }),
      }, controller.signal)
      if (receipt.actionId !== prepared.params.actionId || Number.isNaN(Date.parse(receipt.performedAt))) {
        throw new ComputerUseError('BAD_MESSAGE', 'The native helper returned an invalid action receipt.', true)
      }
      helperAcknowledged = true
      this.assertNotAborted(controller.signal)
      const observation = await this.captureObservation(
        prepared.params.sessionId,
        prepared.target.bundleId ?? prepared.target.name,
        controller.signal,
      )
      const result: ComputerActionResult = {
        version: COMPUTER_ACTION_VERSION,
        actionId: prepared.params.actionId,
        previousSnapshotId: prepared.params.snapshotId,
        completedAt: this.now().toISOString(),
        action: summarizeComputerAction(prepared.params.action),
        observation: prepared.params.action.kind === 'type'
          ? redactTypedObservation(observation)
          : observation,
      }
      audit.recordOutcome(prepared.params.actionId, 'succeeded', 'completed', observation.snapshotId)
      this.statusMessage = 'Computer action completed and the target was observed again.'
      return result
    } catch (error) {
      if (dispatched) {
        this.lastObservation = undefined
        this.lastObservationSessionId = undefined
      }
      const ambiguous = this.recordActionFailure(
        audit,
        prepared.params.actionId,
        error,
        dispatched,
        helperAcknowledged,
      )
      const wrapped = this.wrapActionError(error, ambiguous)
      this.statusMessage = wrapped.message
      throw wrapped
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.activeActionController === controller) this.activeActionController = undefined
      this.acting = false
      this.bump()
    }
  }

  pauseActions(): ComputerControlSnapshot {
    this.activeActionController?.abort()
    this.actionsPaused = true
    this.statusMessage = 'Computer actions are paused.'
    this.bump()
    return this.snapshot()
  }

  resumeActions(): ComputerControlSnapshot {
    if (!this.policy.allowAnyApplication &&
      !this.policy.applicationRules.some(rule => rule.access === 'allow')) {
      throw new ComputerUseError('PERMISSION_DENIED', 'Allow an application before resuming computer actions.')
    }
    this.actionsPaused = false
    this.statusMessage = 'Computer actions are enabled for allowed applications.'
    this.bump()
    return this.snapshot()
  }

  async stop(pauseActions = true): Promise<ComputerControlSnapshot> {
    this.activeController?.abort()
    this.activeController = undefined
    this.activeActionController?.abort()
    this.actionsPaused = pauseActions
    this.selectedTarget = undefined
    this.lastObservation = undefined
    this.lastObservationSessionId = undefined
    this.observing = false
    this.statusMessage = undefined
    await this.captures.cleanup()
    this.bump()
    return this.snapshot()
  }

  async dispose(): Promise<void> {
    await this.stop(true)
    await this.helper.dispose()
  }

  private prepareAction(value: ComputerActParams): PreparedComputerAction {
    const params = value
    if (!this.permissions.canAct) {
      throw new ComputerUseError(
        'PERMISSION_DENIED',
        'Screen Recording and Accessibility permissions are required before computer actions can run.',
      )
    }
    const target = this.selectedTarget
    const observation = this.lastObservation
    if (target === undefined || observation === undefined) {
      throw new ComputerUseError('NOT_FOUND', 'Observe an application or window before requesting an action.')
    }
    if (target.kind === 'display' || target.pid === undefined) {
      throw new ComputerUseError(
        'PERMISSION_DENIED',
        'Computer actions require an explicitly selected application or window.',
      )
    }
    if (params.snapshotId !== observation.snapshotId || params.sessionId !== this.lastObservationSessionId) {
      throw new ComputerUseError('TARGET_CHANGED', 'The computer snapshot is stale. Observe the target again.')
    }
    if (observation.target.id !== target.id || observation.target.kind !== target.kind) {
      throw new ComputerUseError('TARGET_CHANGED', 'The selected computer target changed after observation.')
    }
    const application = observation.foregroundApplication
    if (application === undefined || application.pid !== target.pid ||
      (target.bundleId !== undefined && application.bundleId !== target.bundleId) ||
      observation.compatibility.foregroundApplicationId !== application.id) {
      throw new ComputerUseError(
        'TARGET_CHANGED',
        'Bring the selected application to the foreground and observe it again before acting.',
      )
    }

    const elementId = params.action.kind === 'type'
      ? params.action.elementId
      : params.action.kind === 'click' && params.action.target.mode === 'element'
        ? params.action.target.elementId
        : params.action.kind === 'scroll' && params.action.target?.mode === 'element'
          ? params.action.target.elementId
          : undefined
    const element = elementId === undefined
      ? undefined
      : observation.elements.find(candidate => candidate.id === elementId)
    if (elementId !== undefined && element === undefined) {
      throw new ComputerUseError('TARGET_CHANGED', 'The requested interface element is not in the latest snapshot.')
    }
    if (element?.secure === true) {
      throw new ComputerUseError('PERMISSION_DENIED', 'Computer actions are not allowed on secure text fields.')
    }
    if (params.action.kind === 'type' && element !== undefined &&
      !/text|combo/i.test(element.role)) {
      throw new ComputerUseError('BAD_MESSAGE', 'Text can only be entered into a text-editable interface element.')
    }
    const pointTarget = params.action.kind === 'click'
      ? params.action.target.mode === 'point' ? params.action.target : undefined
      : params.action.kind === 'scroll' && params.action.target?.mode === 'point'
        ? params.action.target
        : undefined
    if (pointTarget !== undefined &&
      (pointTarget.point.x > observation.capture.bounds.width ||
        pointTarget.point.y > observation.capture.bounds.height)) {
      throw new ComputerUseError('BAD_MESSAGE', 'The fallback point is outside the observed capture bounds.')
    }

    if (!this.targetAllowed(target)) {
      throw new ComputerUseError(
        'PERMISSION_DENIED',
        `${application.name} is not allowed in Computer Control settings.`,
      )
    }
    if (this.actionsPaused) {
      throw new ComputerUseError('PERMISSION_DENIED', 'Computer actions are paused in Desktop settings.')
    }
    return { params, target: cloneTarget(target), observation, ...(element === undefined ? {} : { element }) }
  }

  private recordActionFailure(
    audit: ComputerActionAuditStore,
    actionId: string,
    error: unknown,
    dispatched: boolean,
    helperAcknowledged: boolean,
  ): boolean {
    if (!dispatched) {
      try {
        audit.recordOutcome(actionId, 'cancelled', 'cancelled-before-dispatch')
      } catch {
        return false
      }
      return false
    }
    const safeRejection = !helperAcknowledged && error instanceof ComputerUseError &&
      (error.code === 'TARGET_CHANGED' || error.code === 'PERMISSION_DENIED' ||
        error.code === 'NOT_FOUND' || error.code === 'UNSUPPORTED')
    try {
      if (safeRejection) {
        audit.recordOutcome(actionId, 'failed', 'helper-rejected')
        return false
      }
      audit.recordOutcome(
        actionId,
        'ambiguous',
        helperAcknowledged ? 'observation-failed' : 'helper-result-ambiguous',
      )
    } catch {
      return true
    }
    return true
  }

  private wrapActionError(error: unknown, ambiguous: boolean): ComputerUseError {
    if (ambiguous) {
      return new ComputerUseError(
        'DESKTOP_UNAVAILABLE',
        'The computer action may have completed, but its result could not be verified. Do not retry it.',
        true,
      )
    }
    if (error instanceof ComputerUseError) return error
    if (error instanceof ComputerActionAuditError) {
      return new ComputerUseError(error.code, error.message)
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new ComputerUseError('CANCELLED', 'The computer action was cancelled before dispatch.')
    }
    return new ComputerUseError(
      'DESKTOP_UNAVAILABLE',
      error instanceof Error ? error.message : 'The computer action failed before dispatch.',
    )
  }

  private applicationAccess(): ComputerApplicationAccess[] {
    const running = new Map<string, ComputerTarget & { pid: number }>()
    for (const target of this.targets) {
      if (target.kind !== 'application' || target.pid === undefined) continue
      const key = target.bundleId ?? target.id
      const existing = running.get(key)
      if (existing === undefined || target.frontmost === true) {
        running.set(key, { ...target, pid: target.pid })
      }
    }
    const result: ComputerApplicationAccess[] = [...running.values()].map(target => {
      const rule = target.bundleId === undefined
        ? undefined
        : this.policy.applicationRules.find(candidate => candidate.bundleId === target.bundleId)
      return {
        id: target.id,
        name: target.name,
        ...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
        pid: target.pid,
        frontmost: target.frontmost ?? false,
        running: true,
        allowed: this.targetAllowed(target),
        policy: rule?.access ?? 'default',
        canSetPolicy: target.bundleId !== undefined,
      }
    })
    for (const rule of this.policy.applicationRules) {
      if (running.has(rule.bundleId)) continue
      result.push({
        id: `bundle:${rule.bundleId}`,
        name: rule.name,
        bundleId: rule.bundleId,
        frontmost: false,
        running: false,
        allowed: rule.access === 'allow',
        policy: rule.access,
        canSetPolicy: true,
      })
    }
    return result.sort((left, right) => {
      if (left.frontmost !== right.frontmost) return left.frontmost ? -1 : 1
      if (left.running !== right.running) return left.running ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }

  private resolveAllowedTarget(reference?: string): ComputerTarget {
    const applications = this.targets.filter((target): target is ComputerTarget & { pid: number } =>
      target.kind === 'application' && target.pid !== undefined)
    const normalized = reference?.trim().toLocaleLowerCase()
    let target: ComputerTarget | undefined
    if (normalized === undefined || normalized === '') {
      target = applications.find(candidate => candidate.frontmost === true)
      if (target === undefined) {
        throw new ComputerUseError('NOT_FOUND', 'No frontmost application is available to observe.')
      }
    } else {
      const exact = applications.filter(candidate =>
        candidate.id.toLocaleLowerCase() === normalized ||
        candidate.bundleId?.toLocaleLowerCase() === normalized ||
        candidate.name.toLocaleLowerCase() === normalized)
      const partial = exact.length === 0
        ? applications.filter(candidate => candidate.name.toLocaleLowerCase().includes(normalized))
        : []
      const matches = exact.length > 0 ? exact : partial
      if (matches.length === 0) {
        throw new ComputerUseError('NOT_FOUND', `The application "${reference}" is not running.`)
      }
      if (matches.length > 1) {
        target = matches.find(candidate => candidate.frontmost === true)
        if (target === undefined) {
          throw new ComputerUseError('CONFLICT', `More than one running application matches "${reference}".`)
        }
      } else {
        target = matches[0]
      }
    }
    if (!this.targetAllowed(target)) {
      throw new ComputerUseError(
        'PERMISSION_DENIED',
        `${target.name} is not allowed in Computer Control settings.`,
      )
    }
    return cloneTarget(target)
  }

  private targetAllowed(target: ComputerTarget): boolean {
    if (target.kind !== 'application' || target.pid === undefined) return false
    const bundleId = target.bundleId
    const lockScreen = bundleId === 'com.apple.loginwindow' ||
      bundleId === 'com.apple.ScreenSaver.Engine' || /lock screen|loginwindow/i.test(target.name)
    if (lockScreen && !this.policy.lockScreenOperations) return false
    const rule = bundleId === undefined
      ? undefined
      : this.policy.applicationRules.find(candidate => candidate.bundleId === bundleId)
    return rule === undefined ? this.policy.allowAnyApplication : rule.access === 'allow'
  }

  private clearTransientObservation(): void {
    this.activeController?.abort()
    this.activeActionController?.abort()
    this.selectedTarget = undefined
    this.lastObservation = undefined
    this.lastObservationSessionId = undefined
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
