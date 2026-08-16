import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BrowserStore, DEFAULT_BROWSER_SETTINGS } from './browser-store'

test('persists versioned browser policy and bounded history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-store-'))
  const path = join(root, 'browser.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new BrowserStore(path)

  assert.deepEqual(store.load(), {
    settings: DEFAULT_BROWSER_SETTINGS,
    history: [],
    recovered: false,
  })
  const settings = { ...DEFAULT_BROWSER_SETTINGS, enabled: true, storageMode: 'persistent' as const }
  const history = [{
    id: 'history-1',
    url: 'https://example.com/',
    title: 'Example',
    visitedAt: '2026-08-16T08:00:00.000Z',
  }]
  store.save(settings, history)

  assert.deepEqual(new BrowserStore(path).load(), { settings, history, recovered: false })
  assert.equal((await readFile(path, 'utf8')).includes('"schemaVersion": 2'), true)
})

test('migrates the published isolated-profile schema to one persistent managed profile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-store-'))
  const path = join(root, 'browser.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const history = [{
    id: 'history-1',
    url: 'https://example.com/',
    title: 'Example',
    visitedAt: '2026-08-16T08:00:00.000Z',
  }]
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    settings: { ...DEFAULT_BROWSER_SETTINGS, enabled: true, storageMode: 'isolated' },
    history,
  }))

  const loaded = new BrowserStore(path).load()
  assert.equal(loaded.recovered, false)
  assert.equal(loaded.settings.enabled, true)
  assert.equal(loaded.settings.storageMode, 'persistent')
  assert.deepEqual(loaded.history, history)
  const migrated = JSON.parse(await readFile(path, 'utf8')) as {
    schemaVersion: number
    settings: { storageMode: string }
  }
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.settings.storageMode, 'persistent')
})

test('fails closed when browser persistence is corrupt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-store-'))
  const path = join(root, 'browser.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path, '{"schemaVersion":1,"settings":{"enabled":true},"history":[]}')
  const errors: unknown[] = []

  const loaded = new BrowserStore(path, error => errors.push(error)).load()
  assert.equal(loaded.recovered, true)
  assert.deepEqual(loaded.settings, DEFAULT_BROWSER_SETTINGS)
  assert.deepEqual(loaded.history, [])
  assert.equal(errors.length, 1)
})
