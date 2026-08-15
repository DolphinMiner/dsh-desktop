import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { restoreWindowState, WindowStateStore } from './window-state'

const display = { x: 0, y: 0, width: 1728, height: 1080 }

test('restores a valid window and clamps it to the current display work area', () => {
  assert.deepEqual(restoreWindowState({
    version: 1,
    bounds: { x: 1600, y: 900, width: 1200, height: 700 },
    maximized: false,
  }, [display]), {
    version: 1,
    bounds: { x: 528, y: 380, width: 1200, height: 700 },
    maximized: false,
  })
})

test('rejects corrupt, undersized, and fully off-screen window state', () => {
  assert.equal(restoreWindowState({ version: 2 }, [display]), undefined)
  assert.equal(restoreWindowState({
    version: 1,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    maximized: false,
  }, [display]), undefined)
  assert.equal(restoreWindowState({
    version: 1,
    bounds: { x: 4000, y: 4000, width: 900, height: 700 },
    maximized: true,
  }, [display]), undefined)
})

test('persists the latest state atomically and restores it after a cold start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-state-'))
  const path = join(root, 'window-state.v1.json')
  const first = new WindowStateStore(path, { saveDelayMs: 1 })
  const expected = {
    version: 1 as const,
    bounds: { x: 120, y: 80, width: 1280, height: 820 },
    maximized: true,
  }
  try {
    first.schedule({
      version: 1,
      bounds: { x: 0, y: 0, width: 900, height: 700 },
      maximized: false,
    })
    first.schedule(expected)
    await first.flush()

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), expected)
    const second = new WindowStateStore(path)
    assert.deepEqual(await second.load([display]), expected)

    await writeFile(path, '{not json')
    assert.equal(await second.load([display]), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
