import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  COMPUTER_OBSERVATION_VERSION,
  ComputerElement,
  ComputerPermissions,
  ComputerTarget,
  ComputerTargetList,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  ComputerCaptureStore,
  ComputerHelper,
  ComputerHelperActInput,
  ComputerHelperObserveInput,
  ComputerObserver,
  ComputerUseError,
} from './computer-observer'
import { ComputerActionAuditStore } from './computer-action-audit'
import { ComputerControlPolicyStore } from './computer-policy'

const granted: ComputerPermissions = {
  supported: true,
  screenRecording: 'granted',
  accessibility: 'granted',
  canObserve: true,
  canAct: true,
}

const targets: ComputerTarget[] = [
  { id: 'display:1', kind: 'display', name: 'Built-in Display', displayScale: 2 },
  { id: 'display:2', kind: 'display', name: 'Studio Display', displayScale: 1.5 },
  { id: 'application:42', kind: 'application', name: 'Editor', bundleId: 'dev.editor', pid: 42, frontmost: true },
  {
    id: 'window:7',
    kind: 'window',
    name: 'README.md',
    applicationName: 'Editor',
    bundleId: 'dev.editor',
    pid: 42,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  },
]

class FakeHelper implements ComputerHelper {
  permissions = granted
  targetList: ComputerTargetList = { permissions: granted, targets }
  observeCalls: ComputerHelperObserveInput[] = []
  actCalls: ComputerHelperActInput[] = []
  observeError?: Error
  actError?: Error
  hangAction = false
  elements: ComputerElement[] = [{
    id: 'ax:0',
    role: 'AXButton',
    label: 'Continue',
    actions: ['AXPress'],
    bounds: { x: 20, y: 20, width: 80, height: 30 },
    secure: false,
  }]

  async getPermissions(): Promise<ComputerPermissions> {
    return this.permissions
  }

  async listTargets(): Promise<ComputerTargetList> {
    return this.targetList
  }

  async observe(input: ComputerHelperObserveInput): Promise<unknown> {
    this.observeCalls.push(input)
    if (this.observeError !== undefined) throw this.observeError
    await writeFile(input.screenshotPath, Buffer.from('png'))
    return {
      version: COMPUTER_OBSERVATION_VERSION,
      snapshotId: input.snapshotId,
      observedAt: '2026-08-16T12:00:00.000Z',
      target: input.target,
      foregroundApplication: {
        id: 'application:42',
        name: 'Editor',
        bundleId: 'dev.editor',
        pid: 42,
        frontmost: true,
      },
      compatibility: {
        surfaceId: 'window:7:42',
        surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
        displayTopology: [{
          id: 'display:1',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          displayScale: input.target.displayScale ?? 2,
        }],
        foregroundApplicationId: 'application:42',
      },
      capture: {
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        displayScale: input.target.displayScale ?? 2,
        pixelWidth: 1600,
        pixelHeight: 1200,
        screenshotCaptured: true,
        ocrText: 'README.md',
      },
      elements: this.elements,
      truncated: false,
      warnings: [],
    }
  }

  async act(input: ComputerHelperActInput, signal?: AbortSignal): Promise<{ actionId: string; performedAt: string }> {
    this.actCalls.push(input)
    if (this.actError !== undefined) throw this.actError
    if (this.hangAction) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      })
    }
    return { actionId: input.actionId, performedAt: '2026-08-16T12:00:00.500Z' }
  }

  async dispose(): Promise<void> {}
}

async function fixture(
  options: ConstructorParameters<typeof ComputerCaptureStore>[1] = {},
  withAudit = false,
  allowAnyApplication = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-test-'))
  const helper = new FakeHelper()
  const captures = new ComputerCaptureStore(join(root, 'captures'), options)
  const auditPath = join(root, 'computer-actions.v1.json')
  const audit = withAudit
    ? new ComputerActionAuditStore(auditPath)
    : undefined
  const policyPath = join(root, 'computer-control-policy.v1.json')
  const observer = new ComputerObserver(helper, captures, {
    audit,
    policyStore: new ComputerControlPolicyStore(policyPath),
  })
  if (allowAnyApplication) observer.updatePolicy({ allowAnyApplication: true })
  return { root, helper, captures, observer, audit, auditPath, policyPath }
}

test('requires permission and automatically resolves an allowed frontmost application', async t => {
  const { root, helper, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))

  helper.permissions = { ...granted, screenRecording: 'denied', canObserve: false, canAct: false }
  helper.targetList = { permissions: helper.permissions, targets }
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'PERMISSION_DENIED')
  assert.equal(helper.observeCalls.length, 0)

  helper.permissions = granted
  helper.targetList = {
    permissions: granted,
    targets: targets.map(target => target.id === 'application:42' ? { ...target, frontmost: false } : target),
  }
  await observer.refresh()
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) => error.code === 'NOT_FOUND')
})

test('preserves display scale, bounds output, and bounded screenshot retention', async t => {
  const { root, observer } = await fixture({ maxFiles: 1 })
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await observer.observe('session-1')
  const second = await observer.observe('session-1')

  assert.equal(first.capture.displayScale, 2)
  assert.deepEqual(second.capture.bounds, { x: 0, y: 0, width: 800, height: 600 })
  assert.equal((await readdir(join(root, 'captures'))).length, 1)
  assert.equal(observer.snapshot().lastObservation?.snapshotId, second.snapshotId)
})

test('turns helper crashes and malformed secure values into safe failures and cleanup', async t => {
  const { root, helper, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  helper.observeError = new Error('helper exited with status 9')
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'DESKTOP_UNAVAILABLE' && !error.message.includes('secret'))
  const entries = await readdir(join(root, 'captures')).catch(() => [])
  assert.deepEqual(entries, [])
})

test('stop clears transient capture state without revoking durable app policy', async t => {
  const { root, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  await observer.observe('session-1')

  const stopped = await observer.stop()
  assert.equal(stopped.enabled, true)
  assert.equal(stopped.actionsPaused, true)
  assert.equal(stopped.activeTarget, undefined)
  assert.deepEqual(await readdir(join(root, 'captures')).catch(() => []), [])
})

test('persists one app policy and resolves it by name or bundle identifier after restart', async t => {
  const { root, observer, policyPath } = await fixture({}, false, false)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'PERMISSION_DENIED')
  const allowed = observer.updatePolicy({
    application: { bundleId: 'dev.editor', name: 'Editor', allowed: true },
  })
  assert.deepEqual(allowed.policy.applicationRules, [{
    bundleId: 'dev.editor',
    name: 'Editor',
    access: 'allow',
  }])
  assert.equal((await observer.observe('session-1', 'Editor')).target.id, 'window:7')

  const restarted = new ComputerObserver(
    new FakeHelper(),
    new ComputerCaptureStore(join(root, 'restart-captures')),
    { policyStore: new ComputerControlPolicyStore(policyPath) },
  )
  t.after(() => restarted.dispose())
  assert.equal((await restarted.observe('session-2', 'dev.editor')).target.id, 'window:7')
})

test('binds a named application to its largest current window before native capture', async t => {
  const { root, helper, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  helper.targetList = {
    permissions: granted,
    targets: [
      { id: 'application:91', kind: 'application', name: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 91 },
      {
        id: 'window:small',
        kind: 'window',
        name: 'Downloads',
        applicationName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        pid: 91,
        bounds: { x: 10, y: 10, width: 480, height: 320 },
      },
      {
        id: 'window:large',
        kind: 'window',
        name: 'ailoha.ai',
        applicationName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        pid: 91,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
      },
    ],
  }

  const observation = await observer.observe('session-chrome', 'Google Chrome')
  assert.equal(observation.target.id, 'window:large')
  assert.equal(helper.observeCalls[0]?.target.id, 'window:large')
  assert.equal(observer.snapshot().activeTarget?.bundleId, 'com.google.Chrome')
})

test('keeps lock screen targets denied until the dedicated policy is enabled', async t => {
  const { root, helper, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  helper.targetList = {
    permissions: granted,
    targets: [{
      id: 'application:loginwindow',
      kind: 'application',
      name: 'Lock Screen',
      bundleId: 'com.apple.loginwindow',
      pid: 9,
      frontmost: true,
    }],
  }

  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'PERMISSION_DENIED')
  const enabled = observer.updatePolicy({ lockScreenOperations: true })
  assert.equal(enabled.policy.lockScreenOperations, true)
  assert.equal((await observer.observe('session-1')).target.id, 'application:loginwindow')
})

test('uses durable app policy and re-observes after an approved Harness action', async t => {
  const { root, helper, observer, audit } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await observer.observe('session-1')
  const action = {
    actionId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1',
    snapshotId: source.snapshotId,
    action: {
      kind: 'click' as const,
      target: { mode: 'element' as const, elementId: 'ax:0' },
      button: 'left' as const,
      clickCount: 1 as const,
    },
  }

  const result = await observer.act(action)
  assert.equal(result.previousSnapshotId, source.snapshotId)
  assert.notEqual(result.observation.snapshotId, source.snapshotId)
  assert.equal(result.action.kind, 'click')
  assert.equal(helper.actCalls[0]?.element?.id, 'ax:0')
  assert.deepEqual(audit?.recent()[0]?.events.map(event => event.phase), [
    'intent', 'approved', 'dispatch', 'succeeded',
  ])
})

test('redacts typed values and OCR from the post-action result', async t => {
  const { root, helper, observer } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  helper.elements = [{
    id: 'ax:text',
    role: 'AXTextField',
    label: 'Draft',
    value: 'before',
    actions: [],
    bounds: { x: 20, y: 20, width: 180, height: 30 },
    secure: false,
  }]
  const source = await observer.observe('session-1')
  const request = {
    actionId: '77777777-7777-4777-8777-777777777777',
    sessionId: 'session-1',
    snapshotId: source.snapshotId,
    action: {
      kind: 'type' as const,
      elementId: 'ax:text',
      text: 'private draft',
      replace: true,
    },
  }
  helper.elements = [{ ...helper.elements[0]!, value: 'private draft' }]

  const result = await observer.act(request)
  assert.deepEqual(result.action, {
    kind: 'type',
    elementId: 'ax:text',
    textLength: 13,
    replace: true,
  })
  assert.equal(result.observation.capture.ocrText, undefined)
  assert.equal(result.observation.elements[0]?.value, undefined)
  assert.equal(JSON.stringify(result).includes('private draft'), false)
})

test('projects pause, resume, and durable app overrides from one policy state', async t => {
  const { root, observer } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(observer.pauseActions().actionsPaused, true)
  assert.equal(observer.resumeActions().actionsPaused, false)
  const denied = observer.updatePolicy({
    application: { bundleId: 'dev.editor', name: 'Editor', allowed: false },
  })
  assert.equal(denied.applications.find(application => application.bundleId === 'dev.editor')?.allowed, false)
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'PERMISSION_DENIED')
})

test('rejects stale snapshots and secure fields before dispatch', async t => {
  const { root, helper, observer, audit } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await observer.observe('session-1')
  const grantRequest = {
    actionId: '22222222-2222-4222-8222-222222222222',
    sessionId: 'session-1',
    snapshotId: first.snapshotId,
    action: { kind: 'key' as const, key: 'escape', modifiers: [] },
  }
  await observer.observe('session-1')
  await assert.rejects(observer.act(grantRequest), (error: ComputerUseError) =>
    error.code === 'TARGET_CHANGED')
  assert.equal(helper.actCalls.length, 0)
  assert.equal(audit?.has(grantRequest.actionId), false)

  helper.elements = [{
    id: 'ax:secure',
    role: 'AXSecureTextField',
    label: 'Password',
    actions: [],
    bounds: { x: 30, y: 30, width: 180, height: 30 },
    secure: true,
  }]
  const secure = await observer.observe('session-1')
  await assert.rejects(observer.act({
    actionId: '33333333-3333-4333-8333-333333333333',
    sessionId: 'session-1',
    snapshotId: secure.snapshotId,
    action: { kind: 'type', elementId: 'ax:secure', text: 'never-store-this', replace: true },
  }), (error: ComputerUseError) => error.code === 'PERMISSION_DENIED')
  assert.equal(helper.actCalls.length, 0)
})

test('emergency pause makes an in-flight action ambiguous and blocks replay after restart', async t => {
  const { root, helper, observer, audit } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await observer.observe('session-1')
  const action = {
    actionId: '44444444-4444-4444-8444-444444444444',
    sessionId: 'session-1',
    snapshotId: source.snapshotId,
    action: { kind: 'key' as const, key: 'enter', modifiers: [] },
  }
  helper.hangAction = true
  const pending = observer.act(action)
  while (helper.actCalls.length === 0) await new Promise(resolve => setImmediate(resolve))
  observer.pauseActions()
  await assert.rejects(pending, (error: ComputerUseError) =>
    error.code === 'DESKTOP_UNAVAILABLE' && error.ambiguous)
  assert.equal(audit?.recent()[0]?.events.at(-1)?.phase, 'ambiguous')

  const restarted = new ComputerObserver(
    new FakeHelper(),
    new ComputerCaptureStore(join(root, 'restart-captures')),
    { audit: new ComputerActionAuditStore(join(root, 'computer-actions.v1.json')) },
  )
  t.after(() => restarted.dispose())
  await assert.rejects(restarted.act(action), (error: ComputerUseError) =>
    error.code === 'DUPLICATE_REQUEST')
})

test('does not dispatch when action intent cannot be persisted', async t => {
  const { root, auditPath, helper, observer } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await observer.observe('session-1')
  const action = {
    actionId: '55555555-5555-4555-8555-555555555555',
    sessionId: 'session-1',
    snapshotId: source.snapshotId,
    action: { kind: 'key' as const, key: 'escape', modifiers: [] },
  }
  await mkdir(auditPath)

  await assert.rejects(observer.act(action), (error: ComputerUseError) =>
    error.code === 'DESKTOP_UNAVAILABLE' && !error.ambiguous)
  assert.equal(helper.actCalls.length, 0)
  assert.equal(observer.snapshot().auditAvailable, false)
})

test('keeps durable policy while Accessibility loss blocks actions', async t => {
  const { root, helper, observer } = await fixture({}, true)
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await observer.observe('session-1')
  helper.permissions = { ...granted, accessibility: 'denied', canAct: false }
  helper.targetList = { permissions: helper.permissions, targets }
  const snapshot = await observer.refresh()
  assert.equal(snapshot.policy.allowAnyApplication, true)
  assert.equal(snapshot.actionsPaused, false)
  await assert.rejects(observer.act({
    actionId: '66666666-6666-4666-8666-666666666666',
    sessionId: 'session-1',
    snapshotId: source.snapshotId,
    action: { kind: 'key', key: 'escape', modifiers: [] },
  }), (error: ComputerUseError) => error.code === 'PERMISSION_DENIED')
})
