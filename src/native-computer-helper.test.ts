import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { NativeComputerHelper } from './native-computer-helper'
import { ComputerUseError } from './computer-observer'

const fixture = join(process.cwd(), 'test', 'fixtures', 'fake-computer-helper.mjs')

function helper(mode?: string, timeoutMs = 2_000, maxOutputBytes = 4 * 1024 * 1024) {
  return new NativeComputerHelper(process.execPath, {
    args: [fixture],
    env: { ...process.env, ...(mode === undefined ? {} : { DSH_COMPUTER_FIXTURE_MODE: mode }) },
    timeoutMs,
    maxOutputBytes,
  })
}

test('validates native permission, target, and observation responses', async t => {
  const client = helper()
  t.after(() => client.dispose())
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-helper-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const permissions = await client.getPermissions()
  assert.equal(permissions.accessibility, 'denied')
  const list = await client.listTargets()
  assert.equal(list.targets[0]?.id, 'application:42')
  const screenshotPath = join(root, 'capture.png')
  const observation = await client.observe({
    snapshotId: 'f4205fd4-0b7d-49da-9c88-cd8ce41ae999',
    target: list.targets[0]!,
    screenshotPath,
    maxDepth: 12,
    maxElements: 400,
  })
  assert.equal(observation.capture.ocrText, 'Editor')
})

test('kills a timed out or cancelled helper without replay', async t => {
  const timedOut = helper('hang', 20)
  t.after(() => timedOut.dispose())
  await assert.rejects(timedOut.getPermissions(), /timed out/)

  const cancelled = helper('hang')
  t.after(() => cancelled.dispose())
  const controller = new AbortController()
  const pending = cancelled.getPermissions(controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
})

test('rejects oversized output and a non-executable helper', async t => {
  const overflow = helper('overflow', 2_000, 1_024)
  t.after(() => overflow.dispose())
  await assert.rejects(overflow.getPermissions(), /too much data/)

  const root = await mkdtemp(join(tmpdir(), 'dsh-native-helper-mode-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'helper')
  await import('node:fs/promises').then(fs => fs.writeFile(path, '#!/bin/sh\n'))
  await chmod(path, 0o600)
  const invalid = new NativeComputerHelper(path)
  t.after(() => invalid.dispose())
  await assert.rejects(invalid.getPermissions(), /missing or not executable/)
})

test('serializes bounded actions and preserves safe native preflight failures', async t => {
  const client = helper()
  t.after(() => client.dispose())
  const target = (await client.listTargets()).targets[0]!
  const input = {
    actionId: '77777777-7777-4777-8777-777777777777',
    target,
    sourceSnapshotId: 'snapshot-1',
    compatibility: {
      surfaceId: 'window:7:42',
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      displayTopology: [{
        id: 'display:1',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        displayScale: 2,
      }],
      foregroundApplicationId: 'application:42',
    },
    maxDepth: 12,
    maxElements: 400,
    action: { kind: 'key' as const, key: 'escape', modifiers: [] },
  }
  assert.equal((await client.act(input)).actionId, input.actionId)

  const changed = helper('action-target-changed')
  t.after(() => changed.dispose())
  await assert.rejects(changed.act(input), (error: ComputerUseError) =>
    error.code === 'TARGET_CHANGED' && !error.ambiguous)
})
