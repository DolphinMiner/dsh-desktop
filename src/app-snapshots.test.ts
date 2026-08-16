import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ComputerObservation,
  ComputerPermissions,
  ComputerTarget,
  ComputerTargetList,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  AppSnapshotController,
  AppSnapshotSettingsStore,
  AppSnapshotShortcutRegistrar,
} from './app-snapshots'
import {
  ComputerCaptureStore,
  ComputerHelper,
  ComputerHelperActInput,
  ComputerHelperActResult,
  ComputerHelperObserveInput,
} from './computer-observer'

const granted: ComputerPermissions = {
  supported: true,
  screenRecording: 'granted',
  accessibility: 'denied',
  canObserve: true,
  canAct: false,
}

const frontmost: ComputerTarget = {
  id: 'application:42:com.apple.Safari',
  kind: 'application',
  name: 'Safari',
  bundleId: 'com.apple.Safari',
  pid: 42,
  frontmost: true,
}

class FakeShortcuts implements AppSnapshotShortcutRegistrar {
  readonly handlers = new Map<string, () => void>()
  denied = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.denied.has(accelerator)) return false
    this.handlers.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.handlers.delete(accelerator)
  }
}

class FakeComputerHelper implements ComputerHelper {
  permissions = granted
  targets: ComputerTarget[] = [frontmost]
  observedTargets: string[] = []

  getPermissions(): Promise<ComputerPermissions> {
    return Promise.resolve({ ...this.permissions })
  }

  listTargets(): Promise<ComputerTargetList> {
    return Promise.resolve({ permissions: { ...this.permissions }, targets: this.targets.map(target => ({ ...target })) })
  }

  async observe(input: ComputerHelperObserveInput): Promise<ComputerObservation> {
    this.observedTargets.push(input.target.id)
    await writeFile(input.screenshotPath, Buffer.from('private-png'))
    return {
      version: 2,
      snapshotId: input.snapshotId,
      observedAt: '2026-08-16T04:00:00.000Z',
      target: { ...input.target },
      foregroundApplication: {
        id: frontmost.id,
        name: frontmost.name,
        bundleId: frontmost.bundleId,
        pid: frontmost.pid!,
        frontmost: true,
      },
      compatibility: {
        surfaceId: frontmost.id,
        surfaceBounds: { x: 0, y: 0, width: 800, height: 500 },
        displayTopology: [{
          id: 'display:1',
          bounds: { x: 0, y: 0, width: 1728, height: 1117 },
          displayScale: 2,
        }],
        foregroundApplicationId: frontmost.id,
      },
      capture: {
        bounds: { x: 0, y: 0, width: 800, height: 500 },
        displayScale: 2,
        pixelWidth: 1600,
        pixelHeight: 1000,
        screenshotCaptured: true,
        ocrText: '  Visible page text  ',
      },
      elements: [],
      truncated: false,
      warnings: [],
    }
  }

  act(_input: ComputerHelperActInput): Promise<ComputerHelperActResult> {
    throw new Error('not used')
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

async function fixture(): Promise<{
  root: string
  helper: FakeComputerHelper
  shortcuts: FakeShortcuts
  controller: AppSnapshotController
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-app-snapshots-'))
  const helper = new FakeComputerHelper()
  const shortcuts = new FakeShortcuts()
  const controller = new AppSnapshotController(
    new AppSnapshotSettingsStore(join(root, 'settings.json')),
    helper,
    new ComputerCaptureStore(join(root, 'captures')),
    shortcuts,
    {
      now: () => new Date('2026-08-16T05:00:00.000Z'),
      processImage: () => ({
        data: new Uint8Array([4, 5, 6]),
        mediaType: 'image/jpeg',
        pixelWidth: 1200,
        pixelHeight: 750,
      }),
    },
  )
  return { root, helper, shortcuts, controller }
}

test('persists settings and keeps shortcut registration truthful', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  let shortcutCount = 0
  const started = await runtime.controller.start(() => { shortcutCount += 1 })
  assert.equal(started.shortcutRegistered, true)
  runtime.shortcuts.handlers.get(started.settings.shortcut)?.()
  assert.equal(shortcutCount, 1)

  const updated = runtime.controller.update({
    shortcut: 'CommandOrControl+Shift+A',
    destination: { kind: 'session', sessionId: 'session-1' },
    captureSound: false,
  })
  assert.equal(updated.shortcutRegistered, true)
  assert.equal(runtime.shortcuts.handlers.has('CommandOrControl+Shift+2'), false)
  assert.deepEqual(JSON.parse(await readFile(join(runtime.root, 'settings.json'), 'utf8')), {
    schemaVersion: 1,
    settings: updated.settings,
  })

  runtime.shortcuts.denied.add('CommandOrControl+Option+2')
  const unavailable = runtime.controller.update({ shortcut: 'CommandOrControl+Option+2' })
  assert.equal(unavailable.shortcutRegistered, false)
  assert.match(unavailable.statusMessage ?? '', /already used/)
})

test('captures the frontmost app and returns only bounded in-memory delivery data', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start(() => undefined)
  const capture = await runtime.controller.capture()

  assert.deepEqual(runtime.helper.observedTargets, [frontmost.id])
  assert.equal(capture.sourceName, 'Safari')
  assert.equal(capture.mediaType, 'image/jpeg')
  assert.deepEqual(capture.data, new Uint8Array([4, 5, 6]))
  assert.equal(capture.ocrText, 'Visible page text')
  assert.equal(capture.destination.kind, 'automatic')
  assert.equal(runtime.controller.snapshot().capturing, false)
  assert.deepEqual(await readFile(join(runtime.root, 'captures', `${capture.id}.png`)).catch(() => undefined), undefined)
})

test('fails clearly when Screen Recording or a frontmost app is unavailable', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start(() => undefined)
  runtime.helper.permissions = { ...granted, screenRecording: 'denied', canObserve: false }
  await assert.rejects(runtime.controller.capture(), /Screen Recording permission/)
  assert.equal(runtime.controller.snapshot().capturing, false)

  runtime.helper.permissions = granted
  runtime.helper.targets = []
  await assert.rejects(runtime.controller.capture(), /No frontmost application/)
})
