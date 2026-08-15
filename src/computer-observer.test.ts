import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  COMPUTER_OBSERVATION_VERSION,
  ComputerPermissions,
  ComputerTarget,
  ComputerTargetList,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  ComputerCaptureStore,
  ComputerHelper,
  ComputerHelperObserveInput,
  ComputerObserver,
  ComputerUseError,
} from './computer-observer'

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
  { id: 'window:7', kind: 'window', name: 'README.md', applicationName: 'Editor', pid: 42 },
]

class FakeHelper implements ComputerHelper {
  permissions = granted
  targetList: ComputerTargetList = { permissions: granted, targets }
  observeCalls: ComputerHelperObserveInput[] = []
  observeError?: Error

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
      elements: [{ id: 'ax:0', role: 'AXWindow', label: 'README.md', actions: [], secure: false }],
      truncated: false,
      warnings: [],
    }
  }

  async dispose(): Promise<void> {}
}

async function fixture(options: ConstructorParameters<typeof ComputerCaptureStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-test-'))
  const helper = new FakeHelper()
  const captures = new ComputerCaptureStore(join(root, 'captures'), options)
  const observer = new ComputerObserver(helper, captures)
  return { root, helper, captures, observer }
}

test('requires permission and an explicit live target before observing', async t => {
  const { root, helper, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))

  helper.permissions = { ...granted, screenRecording: 'denied', canObserve: false, canAct: false }
  helper.targetList = { permissions: helper.permissions, targets }
  await observer.selectTarget('window:7')
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'PERMISSION_DENIED')
  assert.equal(helper.observeCalls.length, 0)

  helper.permissions = granted
  helper.targetList = { permissions: granted, targets: targets.filter(target => target.id !== 'window:7') }
  const snapshot = await observer.refresh()
  assert.equal(snapshot.selectedTarget, undefined)
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) => error.code === 'NOT_FOUND')
})

test('preserves display scale, bounds output, and bounded screenshot retention', async t => {
  const { root, observer } = await fixture({ maxFiles: 1 })
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))

  await observer.selectTarget('display:2')
  const first = await observer.observe('session-1')
  const second = await observer.observe('session-1')

  assert.equal(first.capture.displayScale, 1.5)
  assert.deepEqual(second.capture.bounds, { x: 0, y: 0, width: 800, height: 600 })
  assert.equal((await readdir(join(root, 'captures'))).length, 1)
  assert.equal(observer.snapshot().lastObservation?.snapshotId, second.snapshotId)
})

test('turns helper crashes and malformed secure values into safe failures and cleanup', async t => {
  const { root, helper, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  await observer.selectTarget('application:42')

  helper.observeError = new Error('helper exited with status 9')
  await assert.rejects(observer.observe('session-1'), (error: ComputerUseError) =>
    error.code === 'DESKTOP_UNAVAILABLE' && !error.message.includes('secret'))
  const entries = await readdir(join(root, 'captures')).catch(() => [])
  assert.deepEqual(entries, [])
})

test('stop revokes the target and removes all transient captures', async t => {
  const { root, observer } = await fixture()
  t.after(() => observer.dispose())
  t.after(() => rm(root, { recursive: true, force: true }))
  await observer.selectTarget('window:7')
  await observer.observe('session-1')

  const stopped = await observer.stop()
  assert.equal(stopped.enabled, false)
  assert.equal(stopped.selectedTarget, undefined)
  assert.deepEqual(await readdir(join(root, 'captures')).catch(() => []), [])
})
